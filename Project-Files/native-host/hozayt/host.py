"""The native messaging host: the extension's only way into this machine.

Chrome starts this process, hands it a pipe, and tells it which extension is on
the other end. It is deliberately the smallest component in the product,
because it is the only one an extension can reach:

  * two actions exist, `start` and `status`, and nothing else is honoured;
  * no field of an incoming message is ever used as a path, a port, a command,
    or an argument -- the messages carry no parameters at all;
  * it starts the supervisor and answers questions about it. It cannot stop
    anything, delete anything, read a file, or run anything the installation
    did not ship.

What it returns is the address and session token of the local backend, which is
the one piece of information the extension genuinely needs and cannot work out
for itself.

Protocol, in both directions: a little-endian uint32 length followed by that
many bytes of UTF-8 JSON.
"""

from __future__ import annotations

import json
import os
import struct
import sys
import threading
import time

from . import EXTENSION_ID, __version__, net, places, procs, state
from . import logbook as log

# Chrome's own ceiling for a message a host sends is 1 MB. Ours are a few
# hundred bytes; the cap is here so a malformed length cannot ask for a
# gigabyte of memory.
MAX_MESSAGE_BYTES = 1024 * 1024

ACTIONS = frozenset({"start", "status"})

# How long the host waits for a cold backend before reporting it unavailable.
# A packaged backend answers in a couple of seconds; this is generous because
# the alternative -- reporting a failure to a user whose machine is merely busy
# -- is worse than waiting.
READY_TIMEOUT_SECONDS = 75.0
POLL_SECONDS = 0.5

_write_lock = threading.Lock()
_starting = threading.Event()


# --------------------------------------------------------------------------- #
# Framing
# --------------------------------------------------------------------------- #

def read_message() -> dict | None:
    """The next message, or None at end of stream or on anything malformed."""
    stream = sys.stdin.buffer
    header = stream.read(4)
    if len(header) != 4:
        return None
    (size,) = struct.unpack("<I", header)
    if size == 0 or size > MAX_MESSAGE_BYTES:
        log.warn(f"Refusing a message of {size} bytes.")
        return None
    body = stream.read(size)
    if len(body) != size:
        return None
    try:
        value = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        log.warn("Refusing a message that is not valid JSON.")
        return {}
    return value if isinstance(value, dict) else {}


def send(payload: dict) -> bool:
    """Write one message back to Chrome. False once the pipe is gone."""
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_MESSAGE_BYTES:
        body = json.dumps({"ok": False, "state": "error",
                           "error": "Internal message too large."}).encode("utf-8")
    with _write_lock:
        try:
            sys.stdout.buffer.write(struct.pack("<I", len(body)))
            sys.stdout.buffer.write(body)
            sys.stdout.buffer.flush()
            return True
        except (OSError, ValueError):
            return False


# --------------------------------------------------------------------------- #
# Answers
# --------------------------------------------------------------------------- #

def snapshot() -> dict:
    """What the extension needs to know, from the runtime file plus a probe.

    The runtime file is a claim; the probe is the evidence. A file saying
    "ready" for a backend that stopped without tidying up must not send the
    extension to a dead port.
    """
    runtime = state.read()
    port = runtime.get("port")
    token = runtime.get("token")
    claimed = runtime.get("state")

    if isinstance(port, int) and net.serving(port, net.HOST, token):
        return {
            "ok": True,
            "state": state.READY,
            "host": net.HOST,
            "port": port,
            "token": token,
            "version": __version__,
        }

    if claimed in (state.STARTING, state.RESTARTING) or _starting.is_set():
        return {"ok": False, "state": state.STARTING, "version": __version__}

    if claimed == state.CRASHED:
        return {
            "ok": False,
            "state": state.CRASHED,
            "version": __version__,
            "error": runtime.get("error") or "The local engine stopped unexpectedly.",
            "hint": "Reinstalling Hoza YT usually fixes this.",
        }

    return {"ok": False, "state": state.STOPPED, "version": __version__}


def supervisor_running() -> bool:
    try:
        held = json.loads(places.lock_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return procs.alive(held.get("pid"), exe=held.get("exe"))


def start_supervisor() -> bool:
    """Launch the backend manager, detached, with no window."""
    if supervisor_running():
        log.info("The supervisor is already running.")
        return True
    child = procs.spawn_detached(
        places.relaunch_command("--supervisor"),
        cwd=str(places.program_dir()),
        env=procs.clean_environment(),
    )
    if child is None:
        log.error("The supervisor could not be started.")
        return False
    log.info(f"Started the supervisor (pid {child.pid}).")
    return True


def bring_up() -> None:
    """Get the backend ready and report progress, on a worker thread.

    Runs at most once per host process: `_starting` is both the guard and the
    thing `snapshot` reads to tell "starting" apart from "not running".
    """
    if _starting.is_set():
        return
    _starting.set()
    try:
        current = snapshot()
        if current["ok"]:
            send(current)
            return

        send({"ok": False, "state": state.STARTING, "version": __version__})
        if not start_supervisor():
            send({
                "ok": False,
                "state": state.CRASHED,
                "version": __version__,
                "error": "The Hoza YT local engine could not be started.",
                "hint": "Reinstalling Hoza YT usually fixes this.",
            })
            return

        deadline = time.time() + READY_TIMEOUT_SECONDS
        while time.time() < deadline:
            time.sleep(POLL_SECONDS)
            runtime = state.read()
            port = runtime.get("port")
            if isinstance(port, int) and net.serving(port, net.HOST, runtime.get("token")):
                send({
                    "ok": True,
                    "state": state.READY,
                    "host": net.HOST,
                    "port": port,
                    "token": runtime.get("token"),
                    "version": __version__,
                })
                return
            if runtime.get("state") == state.CRASHED:
                send({
                    "ok": False,
                    "state": state.CRASHED,
                    "version": __version__,
                    "error": runtime.get("error") or "The local engine stopped unexpectedly.",
                    "hint": "Reinstalling Hoza YT usually fixes this.",
                })
                return

        log.error("The backend did not become ready in time.")
        send({
            "ok": False,
            "state": state.STOPPED,
            "version": __version__,
            "error": "The Hoza YT local engine is taking longer than expected.",
            "hint": "It may still be starting. Try again in a moment.",
        })
    except Exception:
        log.exception("Bringing the backend up failed.")
        send({"ok": False, "state": state.CRASHED, "version": __version__,
              "error": "The local engine could not be started."})
    finally:
        _starting.clear()


def handle(message: dict) -> None:
    action = message.get("action")
    if not isinstance(action, str) or action not in ACTIONS:
        log.warn(f"Ignoring an unknown action: {str(action)[:40]!r}")
        send({"ok": False, "state": "error", "version": __version__,
              "error": "Unsupported request."})
        return

    if action == "status":
        send(snapshot())
        return

    # "start". Answering takes as long as a cold start, so it happens off the
    # reading thread: a second message must not queue behind the first.
    threading.Thread(target=bring_up, name="bring-up", daemon=True).start()


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def caller_allowed(argv: list[str]) -> bool:
    """Confirm Chrome says the extension on the pipe is the one we ship.

    Chrome enforces this already through `allowed_origins` in the host
    manifest. Checking it here as well means a manifest that was edited to open
    the host up still gets a host that will not talk to a stranger.
    """
    for arg in argv:
        if arg.startswith("chrome-extension://"):
            origin = arg.rstrip("/").rsplit("/", 1)[-1]
            if origin == EXTENSION_ID:
                return True
            log.warn(f"Refusing a connection from {arg}")
            return False
    # Firefox passes the extension id differently and some builds pass nothing
    # at all. With no origin to check, Chrome's own manifest check stands
    # alone, which is what it was designed to do.
    return True


def main(argv: list[str]) -> int:
    log.bind("host")
    log.install_excepthook()
    places.ensure_dirs()

    # Anything written to stdout that is not a framed message costs us the
    # port, so nothing else may ever have it.
    try:
        if sys.platform.startswith("win"):
            import msvcrt

            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    except (ImportError, OSError, ValueError):
        pass

    if not caller_allowed(argv):
        return 1

    log.info(f"Host {__version__} connected.")
    try:
        while True:
            message = read_message()
            if message is None:
                break
            if message:
                handle(message)
    except Exception:
        log.exception("The host stopped with an unhandled error.")
        return 1

    log.info("Host disconnected.")
    # The supervisor is detached on purpose: the browser closing this pipe is
    # not a reason to abandon a download in progress.
    return 0
