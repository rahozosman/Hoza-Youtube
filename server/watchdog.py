"""Keeps the Hoza YT server alive.

The server is meant to be running whenever the browser extension is clicked,
which means nobody should ever have to start it by hand. This process is what
makes that true: it watches `/api/health` and brings the server back whenever
the answer stops coming.

It restarts on two different failures, not one:

  * the process died      - noticed because the child handle has an exit code
  * the process is hung   - noticed because health stops answering while the
                            process is still alive

`start-server.bat` only ever caught the first. A wedged uvicorn worker would
sit there forever looking healthy from the outside.

Run it directly to watch what it does:

    python watchdog.py                 log to the console and to data/
    python watchdog.py --status        report once and exit
    python watchdog.py --interval 5    poll faster

Normally it is started hidden at sign-in by the scheduled task that
install-service.bat creates.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("HOZA_DATA_DIR") or (HERE / "data")).expanduser()
LOG_PATH = DATA_DIR / "watchdog.log"
LOCK_PATH = DATA_DIR / "watchdog.lock"
SERVER_LOG = DATA_DIR / "server-output.log"

LOG_MAX_BYTES = 1_000_000

# Windows: keep the child off the desktop. Absent elsewhere, hence the getattr.
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# How long a freshly started server may take to answer before the start counts
# as failed. A cold first run compiles bytecode and opens the database.
STARTUP_GRACE_SECONDS = 60

# Waits between failed starts, so a broken install does not spin the CPU.
BACKOFF_SECONDS = (5, 15, 30, 60, 120, 300)


# --------------------------------------------------------------------------- #
# Logging
#
# Deliberately not the logging module: this runs with no console and no parent,
# and a plain appended line that survives a hard kill is worth more here than
# handlers and formatters.
# --------------------------------------------------------------------------- #

def log(message: str) -> None:
    line = f"{datetime.now():%Y-%m-%d %H:%M:%S}  {message}"
    try:
        print(line, flush=True)
    except OSError:
        # No console when launched hidden, and a closed stdout is not fatal.
        pass
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > LOG_MAX_BYTES:
            LOG_PATH.replace(DATA_DIR / "watchdog.log.1")
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        # A watchdog that cannot write its log still has a job to do.
        pass


# --------------------------------------------------------------------------- #
# Single instance
#
# Two watchdogs would fight over the same port: one starts a server, the other
# sees a stranger on 8765 and kills it. The lock file holds a pid, and a pid is
# only believed if a live python process is actually using it.
# --------------------------------------------------------------------------- #

def _pid_alive(pid: int) -> bool:
    try:
        import psutil
    except ImportError:
        return False
    try:
        proc = psutil.Process(pid)
        # A recycled pid belonging to something else must not count as us.
        return proc.is_running() and "python" in proc.name().lower()
    except Exception:
        return False


def claim_lock() -> bool:
    """True if this process now owns the watchdog lock."""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if LOCK_PATH.exists():
            try:
                held = json.loads(LOCK_PATH.read_text(encoding="utf-8")).get("pid")
            except (OSError, ValueError):
                held = None
            if isinstance(held, int) and held != os.getpid() and _pid_alive(held):
                log(f"Another watchdog is already running (pid {held}). Exiting.")
                return False
        LOCK_PATH.write_text(
            json.dumps({"pid": os.getpid(), "started": time.time()}),
            encoding="utf-8",
        )
        return True
    except OSError as err:
        log(f"Could not write the lock file, continuing anyway: {err}")
        return True


def release_lock() -> None:
    try:
        if LOCK_PATH.exists():
            held = json.loads(LOCK_PATH.read_text(encoding="utf-8")).get("pid")
            if held == os.getpid():
                LOCK_PATH.unlink()
    except (OSError, ValueError):
        pass


# --------------------------------------------------------------------------- #
# The server
# --------------------------------------------------------------------------- #

def healthy(host: str, port: int, timeout: float = 5.0) -> bool:
    url = f"http://{host}:{port}/api/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read().decode("utf-8"))
            # "degraded" means ffmpeg is missing: unhappy, but still serving.
            return payload.get("status") in {"online", "degraded"}
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return False


def port_holders(port: int) -> list[int]:
    """Pids listening on `port`. Used to clear a server we did not start."""
    try:
        import psutil
    except ImportError:
        return []
    found = set()
    try:
        for conn in psutil.net_connections(kind="inet"):
            listening = conn.status == psutil.CONN_LISTEN
            if listening and conn.laddr and conn.laddr.port == port and conn.pid:
                found.add(conn.pid)
    except Exception:
        # psutil needs elevation for some sockets; a partial answer is fine.
        pass
    return sorted(found)


def kill(pid: int, what: str) -> None:
    try:
        import psutil
    except ImportError:
        return
    try:
        proc = psutil.Process(pid)
        proc.terminate()
        try:
            proc.wait(timeout=10)
            log(f"Stopped {what} (pid {pid}).")
            return
        except psutil.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
            log(f"Force-stopped {what} (pid {pid}).")
    except Exception as err:
        log(f"Could not stop {what} (pid {pid}): {err}")


def clear_port(port: int) -> None:
    for pid in port_holders(port):
        kill(pid, f"the process holding port {port}")


def spawn(host: str, port: int) -> subprocess.Popen | None:
    """Start server.py detached from any console, output going to a log."""
    sink = subprocess.DEVNULL
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if SERVER_LOG.exists() and SERVER_LOG.stat().st_size > LOG_MAX_BYTES:
            SERVER_LOG.replace(DATA_DIR / "server-output.log.1")
        sink = SERVER_LOG.open("a", encoding="utf-8", errors="replace")
    except OSError:
        pass

    command = [
        sys.executable,
        str(HERE / "server.py"),
        "--no-browser",
        "--host", host,
        "--port", str(port),
    ]
    try:
        child = subprocess.Popen(
            command,
            cwd=str(HERE),
            stdout=sink,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW,
        )
        log(f"Started the server (pid {child.pid}).")
        return child
    except OSError as err:
        log(f"Could not start the server: {err}")
        return None


def wait_until_healthy(host: str, port: int, seconds: int) -> bool:
    deadline = time.time() + seconds
    while time.time() < deadline:
        if healthy(host, port):
            return True
        time.sleep(2)
    return False


# --------------------------------------------------------------------------- #
# The loop
# --------------------------------------------------------------------------- #

class Watchdog:
    def __init__(self, host: str, port: int, interval: int, tolerance: int) -> None:
        self.host = host
        self.port = port
        self.interval = interval
        # How many consecutive silent checks before the server counts as hung.
        self.tolerance = tolerance
        self.child: subprocess.Popen | None = None
        self.misses = 0
        self.failed_starts = 0
        self.restarts = 0
        self.running = True

    def stop(self, *_args) -> None:
        """Leave the server up: a watchdog restart should not drop downloads."""
        log("Watchdog asked to stop. The server is left running.")
        self.running = False

    # -- start -------------------------------------------------------------- #

    def ensure_running(self) -> None:
        """Bring the server up, clearing anything stale that blocks the port."""
        if healthy(self.host, self.port):
            # Someone else's server, or ours from before a watchdog restart.
            if self.child is None:
                log(f"Adopted the server already answering on {self.host}:{self.port}.")
            self.misses = 0
            self.failed_starts = 0
            return

        clear_port(self.port)
        self.child = spawn(self.host, self.port)
        if self.child is None:
            self.back_off()
            return

        if wait_until_healthy(self.host, self.port, STARTUP_GRACE_SECONDS):
            log("The server is healthy.")
            self.misses = 0
            self.failed_starts = 0
            return

        log(f"The server did not answer within {STARTUP_GRACE_SECONDS}s.")
        self.back_off()

    def back_off(self) -> None:
        index = min(self.failed_starts, len(BACKOFF_SECONDS) - 1)
        wait = BACKOFF_SECONDS[index]
        self.failed_starts += 1
        log(f"Waiting {wait}s before trying again (attempt {self.failed_starts}).")
        self.sleep(wait)

    def sleep(self, seconds: float) -> None:
        """Sleep in short slices so a stop request is not ignored for minutes."""
        deadline = time.time() + seconds
        while self.running and time.time() < deadline:
            time.sleep(min(1.0, max(0.0, deadline - time.time())))

    # -- restart ------------------------------------------------------------ #

    def restart(self, reason: str) -> None:
        self.restarts += 1
        log(f"Restarting the server: {reason} (restart #{self.restarts}).")
        if self.child and self.child.poll() is None:
            kill(self.child.pid, "the hung server")
        self.child = None
        clear_port(self.port)
        self.ensure_running()

    # -- the loop ----------------------------------------------------------- #

    def run(self) -> int:
        log("=" * 60)
        log(f"Watchdog started (pid {os.getpid()}), watching {self.host}:{self.port}.")
        log(f"Checking every {self.interval}s, tolerating {self.tolerance} misses.")

        self.ensure_running()

        while self.running:
            self.sleep(self.interval)
            if not self.running:
                break

            # A child that exited is unambiguous, so check it before health.
            if self.child is not None and self.child.poll() is not None:
                self.restart(f"the process exited with code {self.child.returncode}")
                continue

            if healthy(self.host, self.port):
                if self.misses:
                    log(f"The server answered again after {self.misses} silent check(s).")
                self.misses = 0
                continue

            self.misses += 1
            log(f"No answer from health ({self.misses}/{self.tolerance}).")
            if self.misses >= self.tolerance:
                self.misses = 0
                self.restart("health stopped answering")

        log("Watchdog stopped.")
        return 0


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def report(host: str, port: int) -> int:
    """One-shot status, for a person or an installer that wants a yes or no."""
    up = healthy(host, port)
    holders = port_holders(port)
    print(f"server   : {'online' if up else 'not answering'} at http://{host}:{port}")
    print(f"port {port}: {', '.join(f'pid {p}' for p in holders) or 'nothing listening'}")
    try:
        held = json.loads(LOCK_PATH.read_text(encoding="utf-8")).get("pid")
        alive = _pid_alive(held) if isinstance(held, int) else False
        print(f"watchdog : {'running' if alive else 'stale lock'} (pid {held})")
    except (OSError, ValueError):
        print("watchdog : not running")
    print(f"log      : {LOG_PATH}")
    return 0 if up else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Keep the Hoza YT server alive")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--interval", type=int, default=15,
                        help="seconds between health checks")
    parser.add_argument("--tolerance", type=int, default=3,
                        help="silent checks before the server counts as hung")
    parser.add_argument("--status", action="store_true",
                        help="report once and exit")
    args = parser.parse_args()

    if args.status:
        return report(args.host, args.port)

    if not claim_lock():
        return 0

    dog = Watchdog(args.host, args.port, args.interval, max(1, args.tolerance))
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, dog.stop)
        except (ValueError, OSError):
            pass

    try:
        return dog.run()
    finally:
        release_lock()


if __name__ == "__main__":
    sys.exit(main())
