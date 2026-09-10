"""The backend manager.

One of these runs per signed-in user. It owns the backend process and nothing
else: it decides the port, starts the backend, watches it, restarts it when it
dies, and stops it when the last browser window closes. The states it records
in the runtime file are the ones the extension shows:

    starting -> ready
    ready -> crashed -> restarting -> ready

Failure is bounded. After a handful of restarts inside a short window the
supervisor stops trying and records why, because a backend that cannot start is
a fault to report, not a loop to run forever.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import time
from pathlib import Path

from . import (
    APP_ID, EXTENSION_ID, WEBSTORE_EXTENSION_ID, __version__,
    net, places, procs, state,
)
from . import logbook as log

# How often the loop wakes up. Cheap: a process scan, not an HTTP call.
TICK_SECONDS = 3.0

# How often the backend is actually asked whether it is alive.
HEALTH_EVERY_SECONDS = 15.0

# Consecutive silent health checks before the backend is considered wedged.
HEALTH_TOLERANCE = 3

# How long a newly started backend has to answer before it counts as failed.
STARTUP_GRACE_SECONDS = 60.0

# How long after the last browser closes the backend is kept, in case the user
# is only restarting the browser.
BROWSER_GRACE_SECONDS = 30.0

# Restart policy. Five failures inside ten minutes is a broken installation,
# not a transient fault.
BACKOFF_SECONDS = (2, 5, 10, 30, 60)
MAX_RESTARTS = 5
RESTART_WINDOW_SECONDS = 600.0


class Supervisor:
    def __init__(self, *, follow_browser: bool = True) -> None:
        self.follow_browser = follow_browser
        self.host = net.HOST
        self.port = state.remembered_port()
        self.token: str | None = state.new_token()
        self.child = None
        self.adopted = False
        self.running = True
        self.idle = False
        self.misses = 0
        self.restarts: list[float] = []
        self.browser_gone_since: float | None = None

    # -- lifecycle ---------------------------------------------------------- #

    def claim(self) -> bool:
        """Refuse to be the second supervisor. Two would fight over the port."""
        places.ensure_dirs()
        lock = places.lock_path()
        try:
            held = json.loads(lock.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            held = {}
        pid = held.get("pid")
        if isinstance(pid, int) and pid != os.getpid():
            if procs.alive(pid, exe=held.get("exe")):
                log.info(f"Another supervisor already owns this session (pid {pid}).")
                return False
        try:
            lock.write_text(
                json.dumps({
                    "pid": os.getpid(),
                    "exe": str(Path(sys.executable).resolve()),
                    "started": time.time(),
                }),
                encoding="utf-8",
            )
        except OSError:
            # A supervisor that cannot write its lock still has a backend to run.
            pass
        return True

    def release(self) -> None:
        lock = places.lock_path()
        try:
            held = json.loads(lock.read_text(encoding="utf-8"))
            if held.get("pid") == os.getpid():
                lock.unlink(missing_ok=True)
        except (OSError, ValueError):
            pass

    def stop(self, *_args) -> None:
        log.info("Supervisor asked to stop.")
        self.running = False

    # -- the backend -------------------------------------------------------- #

    def _backend_log(self):
        """Somewhere for the backend process output to go. Rotated by size."""
        target = places.log_dir() / "backend.log"
        try:
            places.ensure_dirs()
            if target.exists() and target.stat().st_size > 1_000_000:
                target.replace(places.log_dir() / "backend.log.1")
            return target.open("a", encoding="utf-8", errors="replace")
        except OSError:
            return None

    def usable(self, port: int, token: str | None) -> bool:
        """True when the backend on `port` will accept requests from us."""
        payload = net.health(port, self.host, token, timeout=2.0)
        if not payload or payload.get("app") != APP_ID:
            return False
        if payload.get("status") not in {"online", "degraded"}:
            return False
        if payload.get("requires_token") and not payload.get("authenticated"):
            return False
        return True

    def pick_address(self) -> None:
        """Settle on a port, adopting a backend that is already there.

        A busy port is never cleared by force. The only question asked of it is
        whether a Hoza YT backend is answering that will talk to us; anything
        else keeps its address and we move on.
        """
        remembered = state.read()
        preferred = state.remembered_port()

        for candidate in dict.fromkeys((preferred, net.PREFERRED_PORT)):
            if net.port_free(candidate, self.host):
                self.port, self.adopted = candidate, False
                return
            for token in (remembered.get("token"), None):
                if self.usable(candidate, token):
                    self.port = candidate
                    self.token = token
                    self.adopted = True
                    log.info(f"Adopted the backend already serving on port {candidate}.")
                    return

        port, adopt = net.choose_port(preferred, self.host)
        self.port, self.adopted = port, adopt
        if not adopt:
            log.info(f"Port {preferred} is held by another program. Using {port} instead.")

    def start_backend(self) -> bool:
        """Start the backend and wait for it to answer. True when it does."""
        self.pick_address()
        if self.adopted:
            state.write(state=state.READY, port=self.port, host=self.host,
                        token=self.token, pid=None, adopted=True, error=None)
            return True

        self.token = self.token or state.new_token()
        state.write(state=state.STARTING, port=self.port, host=self.host,
                    token=self.token, adopted=False, error=None)

        env = procs.clean_environment()
        env["HOZA_PACKAGED"] = "1"
        env["HOZA_HOME"] = str(places.data_dir())
        env["HOZA_DATA_DIR"] = str(places.backend_data_dir())
        env["HOZA_API_TOKEN"] = self.token
        env["HOZA_HOST"] = self.host
        env["HOZA_PORT"] = str(self.port)
        env["HOZA_NO_BOOTSTRAP"] = "1"
        # What the setup page needs in order to describe this installation.
        extension_dir = places.program_dir() / "extension"
        if extension_dir.is_dir():
            env["HOZA_EXTENSION_DIR"] = str(extension_dir)
        env["HOZA_EXTENSION_ID"] = EXTENSION_ID
        env["HOZA_WEBSTORE_ID"] = WEBSTORE_EXTENSION_ID

        handle = self._backend_log()
        self.child = procs.spawn_child(
            places.relaunch_command("--backend"),
            cwd=str(places.program_dir()),
            env=env,
            stdout=handle,
        )
        if handle is not None:
            # The child holds its own duplicate; leaving this one open would
            # leak a handle on every restart.
            handle.close()

        if self.child is None:
            log.error("The backend process could not be started.")
            state.write(state=state.CRASHED,
                        error="The local engine could not be started.")
            return False

        log.info(f"Started the backend (pid {self.child.pid}) on {self.host}:{self.port}.")
        if self.wait_until_ready():
            state.write(state=state.READY, pid=self.child.pid, error=None)
            log.info("The backend is ready.")
            return True

        log.error(f"The backend did not answer within {STARTUP_GRACE_SECONDS:.0f}s.")
        self.stop_backend("it never became ready")
        return False

    def wait_until_ready(self) -> bool:
        deadline = time.time() + STARTUP_GRACE_SECONDS
        while self.running and time.time() < deadline:
            if self.child is not None and self.child.poll() is not None:
                log.error(f"The backend exited during start-up "
                          f"(code {self.child.returncode}).")
                return False
            if self.usable(self.port, self.token):
                return True
            time.sleep(1.0)
        return False

    def stop_backend(self, reason: str) -> None:
        if self.child is not None and self.child.poll() is None:
            procs.stop(self.child.pid, what="the backend")
            log.info(f"Stopped the backend: {reason}.")
        self.child = None
        self.misses = 0
        state.clear()

    def note_restart(self) -> bool:
        """Record a restart and say whether another one is allowed."""
        now = time.time()
        self.restarts = [t for t in self.restarts if now - t < RESTART_WINDOW_SECONDS]
        self.restarts.append(now)
        return len(self.restarts) <= MAX_RESTARTS

    def restart(self, reason: str) -> None:
        if not self.note_restart():
            log.error(f"The backend has failed {MAX_RESTARTS} times in "
                      f"{RESTART_WINDOW_SECONDS / 60:.0f} minutes. Giving up.")
            state.write(
                state=state.CRASHED,
                error="The local engine keeps stopping. Reinstalling Hoza YT "
                      "usually fixes this.",
            )
            self.running = False
            return

        attempt = len(self.restarts)
        wait = BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)]
        log.warn(f"Restarting the backend: {reason} (attempt {attempt}, "
                 f"waiting {wait}s).")
        state.write(state=state.RESTARTING, error=None)
        if self.child is not None and self.child.poll() is None:
            procs.stop(self.child.pid, what="the wedged backend")
        self.child = None
        self.sleep(wait)
        if self.running:
            self.start_backend()

    # -- following the browser ---------------------------------------------- #

    def active_jobs(self) -> int:
        payload = net.health(self.port, self.host, self.token, timeout=2.0) or {}
        queue = payload.get("queue") or {}
        try:
            return int(queue.get("active") or 0) + int(queue.get("queued") or 0)
        except (TypeError, ValueError):
            return 0

    def browser_present(self) -> None:
        self.browser_gone_since = None
        if self.idle:
            log.info("A browser opened. Starting the backend.")
            self.idle = False
            self.start_backend()

    def browser_absent(self) -> None:
        """Nothing left to serve. Stop -- but never mid-download."""
        if self.idle:
            return
        now = time.time()
        if self.browser_gone_since is None:
            self.browser_gone_since = now
            return
        if now - self.browser_gone_since < BROWSER_GRACE_SECONDS:
            return

        pending = self.active_jobs()
        if pending:
            self.browser_gone_since = now
            log.info(f"The browser is closed, but {pending} download(s) are still "
                     f"running. Holding the backend open.")
            return

        self.stop_backend("the last browser window closed")
        self.idle = True
        self.browser_gone_since = None

    # -- the loop ----------------------------------------------------------- #

    def sleep(self, seconds: float) -> None:
        deadline = time.time() + seconds
        while self.running and time.time() < deadline:
            time.sleep(min(0.5, max(0.0, deadline - time.time())))

    def run(self) -> int:
        log.info("=" * 60)
        log.info(f"Supervisor {__version__} starting (pid {os.getpid()}).")
        log.info(f"Program   {places.program_dir()}")
        log.info(f"Data      {places.data_dir()}")

        if not self.start_backend():
            self.release()
            return 1

        last_health = time.time()
        while self.running:
            self.sleep(TICK_SECONDS)
            if not self.running:
                break

            if self.follow_browser:
                if procs.browser_running():
                    self.browser_present()
                else:
                    self.browser_absent()
                    continue
                if self.idle:
                    continue

            if time.time() - last_health < HEALTH_EVERY_SECONDS:
                continue
            last_health = time.time()

            # A process that has exited is unambiguous, so ask that first.
            if self.child is not None and self.child.poll() is not None:
                self.restart(f"the process exited with code {self.child.returncode}")
                continue

            if self.usable(self.port, self.token):
                if self.misses:
                    log.info(f"The backend answered again after {self.misses} "
                             f"silent check(s).")
                    state.write(state=state.READY, error=None)
                self.misses = 0
                continue

            self.misses += 1
            log.warn(f"No answer from the backend ({self.misses}/{HEALTH_TOLERANCE}).")
            if self.misses >= HEALTH_TOLERANCE:
                self.misses = 0
                self.restart("it stopped answering")

        self.shut_down()
        log.info("Supervisor stopped.")
        self.release()
        return 0

    def shut_down(self) -> None:
        if self.adopted:
            # Someone else's backend. Ours to use, not ours to stop.
            state.clear()
            return
        if self.child is None:
            state.clear()
            return
        if self.active_jobs():
            log.info("Leaving the backend up: downloads are still running.")
            return
        self.stop_backend("the supervisor is shutting down")


def main(follow_browser: bool = True) -> int:
    log.bind("supervisor")
    log.install_excepthook()
    places.ensure_dirs()

    supervisor = Supervisor(follow_browser=follow_browser)
    if not supervisor.claim():
        return 0
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, supervisor.stop)
        except (ValueError, OSError):
            pass
    try:
        return supervisor.run()
    except Exception:
        log.exception("The supervisor stopped with an unhandled error.")
        state.write(state=state.CRASHED,
                    error="The local engine stopped unexpectedly.")
        supervisor.release()
        return 1
