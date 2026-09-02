"""Runs the Hoza YT server for exactly as long as a browser is open.

The extension can only be clicked from inside a browser, so a browser session
is the whole lifetime the server needs. This file supplies it, and nothing
else is required to make it happen -- no watchdog, no .bat, no .ps1, no .vbs:

  * the first browser window opens   -> the server is started
  * the server dies or wedges        -> it is started again
  * the last browser window closes   -> the server is stopped

A download still in progress holds the server open past the browser closing,
so closing the window never abandons a half-written file.

None of this has to be set up by hand. A browser extension cannot launch a
program, so one local run has to happen before anything can be automatic --
and `server.py` makes that run the only one: the first time the server is ever
started, for any reason, it registers autorun and never needs starting again.

The commands are here for when you want them anyway:

    python autorun.py --install       set it up now rather than on first run
    python autorun.py --uninstall     undo that, and stop everything
    python autorun.py --status        report once and exit
    python autorun.py --stop          stop the server and autorun now
    python autorun.py --update        update yt-dlp, for when links start failing

    python autorun.py                 run the loop here, logging to the console
    python autorun.py --no-follow     keep the server up regardless of browsers

`--install` copies the server to a folder of its own under LOCALAPPDATA and
runs it from there, so emptying this one cannot break it. Pass `--here` to
install it in place instead, and re-run `--install` after editing the code.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr  # noqa: F401

HERE = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("HOZA_DATA_DIR") or (HERE / "data")).expanduser()
LOG_PATH = DATA_DIR / "autorun.log"
LOCK_PATH = DATA_DIR / "autorun.lock"
SERVER_LOG = DATA_DIR / "server-output.log"

LOG_MAX_BYTES = 1_000_000

# Windows: keep children off the desktop. Absent elsewhere, hence the getattr.
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0)

# The browsers the extension can live in, as their process names.
BROWSER_NAMES = {
    "chrome", "chrome.exe",
    "msedge", "msedge.exe",
    "brave", "brave.exe",
    "firefox", "firefox.exe",
    "opera", "opera.exe", "opera_gx", "opera_gx.exe",
    "vivaldi", "vivaldi.exe",
    "chromium", "chromium.exe",
    "thorium", "thorium.exe",
    "browser", "browser.exe",  # Yandex
    "arc", "arc.exe",
}

# How often the browser check runs. Deliberately short: the server has to be
# answering by the time the first click reaches it.
POLL_SECONDS = 3

# Health costs a request, so it runs on its own slower clock.
HEALTH_EVERY_SECONDS = 15

# Consecutive silent health checks before the server counts as hung.
TOLERANCE = 3

# One reading of "no browser" is often just a restart, so the server is only
# stopped after the machine has been browser-free for this long.
BROWSER_GRACE_SECONDS = 25

# A cold first run compiles bytecode and opens the database.
STARTUP_GRACE_SECONDS = 60

# Waits between failed starts, so a broken install does not spin the CPU.
BACKOFF_SECONDS = (5, 15, 30, 60, 120, 300)

# What the server needs before it can serve anything.
REQUIRED_MODULES = ("fastapi", "uvicorn", "httpx", "psutil", "yt_dlp", "imageio_ffmpeg")


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
            LOG_PATH.replace(DATA_DIR / "autorun.log.1")
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except OSError:
        # A supervisor that cannot write its log still has a job to do.
        pass


# --------------------------------------------------------------------------- #
# Single instance
#
# Two copies would fight over the same port: one starts a server, the other
# sees a stranger on 8765 and stops it. The lock file holds a pid, and a pid is
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
    """True if this process now owns the autorun lock."""
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        if LOCK_PATH.exists():
            try:
                held = json.loads(LOCK_PATH.read_text(encoding="utf-8")).get("pid")
            except (OSError, ValueError):
                held = None
            if isinstance(held, int) and held != os.getpid() and _pid_alive(held):
                log(f"Another autorun is already running (pid {held}). Exiting.")
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
# The browser
# --------------------------------------------------------------------------- #

def browser_running() -> bool:
    """True while any browser the extension can run in is alive."""
    try:
        import psutil
    except ImportError:
        # With no way to tell, a server that stays up is a far smaller problem
        # than one that never starts.
        return True
    try:
        for proc in psutil.process_iter(["name"]):
            if (proc.info.get("name") or "").lower() in BROWSER_NAMES:
                return True
    except Exception:
        return True
    return False


# --------------------------------------------------------------------------- #
# The server
# --------------------------------------------------------------------------- #

def health_payload(host: str, port: int, timeout: float = 5.0) -> dict | None:
    """The health document, or None when nothing answered."""
    url = f"http://{host}:{port}/api/health"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            if response.status != 200:
                return None
            payload = json.loads(response.read().decode("utf-8"))
            return payload if isinstance(payload, dict) else None
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None


def healthy(host: str, port: int, timeout: float = 5.0) -> bool:
    payload = health_payload(host, port, timeout)
    # "degraded" means ffmpeg is missing: unhappy, but still serving.
    return bool(payload) and payload.get("status") in {"online", "degraded"}


def unfinished_jobs(host: str, port: int) -> int:
    """Downloads still running or waiting.

    Closing the browser must not abandon a file that is halfway to disk.
    """
    queued = (health_payload(host, port, timeout=2.0) or {}).get("queue") or {}
    try:
        return int(queued.get("active") or 0) + int(queued.get("queued") or 0)
    except (TypeError, ValueError):
        return 0


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
    finally:
        # The child holds its own duplicate of the handle, so this one has done
        # its job. Left open, every restart would leak one.
        if sink is not subprocess.DEVNULL:
            sink.close()


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

class Autorun:
    """Keeps the server's lifetime tied to the browser's."""

    def __init__(self, host: str, port: int, follow: bool = True) -> None:
        self.host = host
        self.port = port
        self.follow = follow
        self.child: subprocess.Popen | None = None
        self.misses = 0
        self.failed_starts = 0
        self.restarts = 0
        self.running = True
        # Down on purpose because no browser is open, as opposed to down
        # because it failed. The two are handled very differently.
        self.idle = False
        self.browser_gone_since: float | None = None

    # -- start -------------------------------------------------------------- #

    def ensure_running(self) -> None:
        """Bring the server up, clearing anything stale that blocks the port."""
        if healthy(self.host, self.port):
            # Someone else's server, or ours from before an autorun restart.
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

    # -- stop and restart --------------------------------------------------- #

    def stop_server(self, reason: str) -> None:
        """Take the server down deliberately. Not a failure, so no backoff."""
        if self.child is not None and self.child.poll() is None:
            kill(self.child.pid, "the server")
        self.child = None
        # Also clears a server this process merely adopted.
        clear_port(self.port)
        self.misses = 0
        self.failed_starts = 0
        log(f"Stopped the server: {reason}.")

    def restart(self, reason: str) -> None:
        self.restarts += 1
        log(f"Restarting the server: {reason} (restart #{self.restarts}).")
        if self.child and self.child.poll() is None:
            kill(self.child.pid, "the hung server")
        self.child = None
        clear_port(self.port)
        self.ensure_running()

    def stop(self, *_args) -> None:
        """Signal handler. The loop finishes its slice and then unwinds."""
        log("Autorun asked to stop.")
        self.running = False

    # -- following the browser ---------------------------------------------- #

    def browser_present(self) -> None:
        """A browser is open, so the server belongs up."""
        self.browser_gone_since = None
        if self.idle:
            log("A browser opened. Starting the server.")
            self.idle = False
            self.ensure_running()

    def browser_absent(self) -> None:
        """No browser is left. Stop the server, as soon as it is safe to."""
        if self.idle:
            return

        now = time.time()
        if self.browser_gone_since is None:
            self.browser_gone_since = now
            return
        if now - self.browser_gone_since < BROWSER_GRACE_SECONDS:
            return

        pending = unfinished_jobs(self.host, self.port)
        if pending:
            # Re-arm the grace, so this is asked again once they have finished.
            self.browser_gone_since = now
            log(f"The browser is closed, but {pending} download(s) are still "
                f"going. Holding the server open until they finish.")
            return

        self.stop_server("the last browser window closed")
        self.idle = True
        self.browser_gone_since = None

    # -- the loop ----------------------------------------------------------- #

    def run(self) -> int:
        log("=" * 60)
        log(f"Autorun started (pid {os.getpid()}), watching {self.host}:{self.port}.")
        log(f"Running from {HERE}.")

        if self.follow:
            log("Following the browser: the server starts with the first "
                "window and stops with the last.")
            if not browser_running():
                self.idle = True
                log("No browser is open yet. Waiting for one.")
        else:
            log("Not following the browser: the server is kept up either way.")

        if not self.idle:
            self.ensure_running()

        # A process scan is cheap next to an HTTP round trip, so the two run on
        # their own clocks: the browser every few seconds so the server is ready
        # before the first click, health at the slower interval.
        step = POLL_SECONDS if self.follow else HEALTH_EVERY_SECONDS
        last_health = time.time()

        while self.running:
            self.sleep(step)
            if not self.running:
                break

            if self.follow:
                if browser_running():
                    self.browser_present()
                else:
                    self.browser_absent()
                    continue
                if self.idle:
                    continue

            if time.time() - last_health < HEALTH_EVERY_SECONDS:
                continue
            last_health = time.time()

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
            log(f"No answer from health ({self.misses}/{TOLERANCE}).")
            if self.misses >= TOLERANCE:
                self.misses = 0
                self.restart("health stopped answering")

        self.shut_down()
        log("Autorun stopped.")
        return 0

    def shut_down(self) -> None:
        """Leaving the server behind would defeat the point of following the
        browser, so it goes too -- unless a download would be lost with it."""
        if self.idle or not self.follow:
            return
        pending = unfinished_jobs(self.host, self.port)
        if pending:
            log(f"Leaving the server up: {pending} download(s) are still going.")
            return
        if healthy(self.host, self.port):
            self.stop_server("autorun is shutting down")


# --------------------------------------------------------------------------- #
# Setting it up
#
# All of it is here, in Python. Windows is driven through schtasks and the
# registry, both of which ship with the OS, so the project carries no .bat,
# .ps1 or .vbs of its own and nothing has to be double-clicked.
# --------------------------------------------------------------------------- #

TASK_NAME = "Hoza YT Autorun"
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_VALUE = "Hoza YT Autorun"

# Where --install puts the server, so that emptying the project folder (or
# re-downloading it) cannot take the running copy with it.
INSTALL_DIR = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData/Local")) \
    / "HozaYT" / "server"

# Never copied into an install: state belongs to the installed copy alone.
NOT_COPIED = {"data", "__pycache__", ".gitignore", "legacy"}

# Traces of the always-on watchdog this replaced. An install clears them out:
# left behind, the watchdog would start the server again every time autorun
# stopped it, and the two would never agree on who is in charge.
LEGACY_TASKS = ("Hoza YT Watchdog",)
LEGACY_LINKS = ("Hoza YT Watchdog.lnk", "Hoza YT Server.lnk", "Hoza YT Autorun.lnk")

TASK_XML = """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Runs the Hoza YT server while a browser is open.</Description>
    <URI>\\{name}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user}</UserId>
      <Delay>PT15S</Delay>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>{start}</StartBoundary>
      <Repetition>
        <Interval>PT10M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>99</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>{arguments}</Arguments>
      <WorkingDirectory>{workdir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""


def say(text: str = "") -> None:
    """Setup talks to a person at a console, so it prints rather than logs."""
    print(text, flush=True)


def hidden_python() -> str:
    """pythonw.exe never allocates a console, which is what keeps autorun off
    the desktop. Falls back to python.exe where there is no pythonw."""
    console = Path(sys.executable)
    quiet = console.with_name("pythonw.exe")
    return str(quiet if quiet.exists() else console)


def run_quiet(command: list[str]) -> tuple[int, str]:
    """Run a Windows tool without flashing a console window at the user."""
    try:
        done = subprocess.run(
            command,
            capture_output=True,
            text=True,
            creationflags=CREATE_NO_WINDOW,
        )
    except OSError as err:
        return 1, str(err)
    return done.returncode, (done.stdout + done.stderr).strip()


def missing_modules() -> list[str]:
    absent = []
    for module in REQUIRED_MODULES:
        try:
            __import__(module)
        except ImportError:
            absent.append(module)
    return absent


def ensure_dependencies(source: Path) -> bool:
    """Install requirements.txt if anything the server needs is missing."""
    if not missing_modules():
        say("   Dependencies OK")
        return True

    requirements = source / "requirements.txt"
    if not requirements.exists():
        say(f"   Missing requirements.txt at {requirements}")
        return False

    say("   Installing requirements (first run only)...")
    done = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(requirements)]
    )
    if done.returncode != 0 or missing_modules():
        say("   Dependency installation failed.")
        return False
    say("   Dependencies OK")
    return True


def copy_server(source: Path, target: Path) -> None:
    """Mirror the project's server into the install folder.

    Files that have gone from the project go from the install too, which is
    what keeps a retired script from being left behind to confuse things. The
    data directory is never touched: it holds the database and the settings.
    """
    target.mkdir(parents=True, exist_ok=True)

    copied = 0
    for item in source.rglob("*"):
        relative = item.relative_to(source)
        if any(part in NOT_COPIED for part in relative.parts):
            continue
        destination = target / relative
        if item.is_dir():
            destination.mkdir(parents=True, exist_ok=True)
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(item, destination)
        copied += 1

    removed = 0
    for item in sorted(target.rglob("*"), reverse=True):
        relative = item.relative_to(target)
        if any(part in NOT_COPIED for part in relative.parts):
            continue
        if (source / relative).exists():
            continue
        try:
            if item.is_dir():
                item.rmdir()
            else:
                item.unlink()
            removed += 1
        except OSError:
            pass

    say(f"   Copied {copied} file(s) to {target}")
    if removed:
        say(f"   Removed {removed} file(s) that are no longer in the project")


def clear_legacy() -> None:
    """Take out the old always-on watchdog, wherever it still lingers.

    Only what it left on the machine -- its task, its shortcut, its process.
    Files in the project are the project's business and are never touched.
    """
    for task in LEGACY_TASKS:
        code, _ = run_quiet(["schtasks", "/Query", "/TN", task])
        if code == 0:
            run_quiet(["schtasks", "/Delete", "/TN", task, "/F"])
            say(f"   Removed the '{task}' scheduled task")

    startup = Path(os.environ.get("APPDATA", "")) / \
        "Microsoft/Windows/Start Menu/Programs/Startup"
    for name in LEGACY_LINKS:
        link = startup / name
        if link.exists():
            try:
                link.unlink()
                say(f"   Removed {name} from Startup")
            except OSError:
                pass

    # A watchdog still in memory keeps its grip on the port until it is stopped.
    for pid in processes_running("watchdog.py"):
        kill(pid, "a running watchdog")


def processes_running(needle: str, exclude_self: bool = True) -> list[int]:
    """Pids of python processes whose command line mentions `needle`."""
    try:
        import psutil
    except ImportError:
        return []
    found = []
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            if exclude_self and proc.info["pid"] == os.getpid():
                continue
            if "python" not in (proc.info.get("name") or "").lower():
                continue
            if any(needle in part for part in (proc.info.get("cmdline") or [])):
                found.append(proc.info["pid"])
        except Exception:
            continue
    return found


def register_task(script: Path) -> bool:
    """A sign-in task, which also restarts autorun if it ever dies.

    Every ten minutes the task tries to start again. While autorun is alive
    that does nothing at all -- IgnoreNew -- and if it is not, it comes back.
    """
    user = os.environ.get("USERNAME", "")
    domain = os.environ.get("USERDOMAIN", "")
    account = f"{domain}\\{user}" if domain and user else user
    if not account:
        say("   Could not work out the current user account")
        return False

    xml = TASK_XML.format(
        name=escape(TASK_NAME),
        user=escape(account),
        start=datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
        command=escape(hidden_python()),
        arguments=escape(f'"{script}"'),
        workdir=escape(str(script.parent)),
    )

    # schtasks reads the definition as UTF-16, and rejects it outright as UTF-8.
    definition = Path(os.environ.get("TEMP", ".")) / "hoza-yt-autorun.xml"
    try:
        definition.write_text(xml, encoding="utf-16")
        code, output = run_quiet(
            ["schtasks", "/Create", "/TN", TASK_NAME, "/XML", str(definition), "/F"]
        )
    finally:
        definition.unlink(missing_ok=True)

    if code == 0:
        say("   Scheduled task registered")
        return True
    say(f"   Task registration refused: {output or 'unknown error'}")
    return False


def register_run_key(script: Path) -> bool:
    """The fallback for a machine where task registration is not allowed.

    A per-user Run value needs no privileges at all. It only fires at sign-in,
    so there is no ten-minute safety net, but the server still comes up on its
    own every session.
    """
    try:
        import winreg
    except ImportError:
        return False
    command = f'"{hidden_python()}" "{script}"'
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.SetValueEx(key, RUN_VALUE, 0, winreg.REG_SZ, command)
    except OSError as err:
        say(f"   Could not write the Run key: {err}")
        return False
    say("   Sign-in registry entry created")
    return True


def clear_run_key() -> bool:
    try:
        import winreg
    except ImportError:
        return False
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0,
                            winreg.KEY_SET_VALUE) as key:
            winreg.DeleteValue(key, RUN_VALUE)
        return True
    except OSError:
        return False


def start_now(script: Path, task: bool) -> None:
    """Get autorun going without waiting for the next sign-in."""
    if task:
        code, output = run_quiet(["schtasks", "/Run", "/TN", TASK_NAME])
        if code == 0:
            return
        say(f"   The task would not start ({output or 'unknown error'}), "
            f"starting autorun directly")
    try:
        subprocess.Popen(
            [hidden_python(), str(script)],
            cwd=str(script.parent),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            stdin=subprocess.DEVNULL,
            creationflags=CREATE_NO_WINDOW | DETACHED_PROCESS,
            close_fds=True,
        )
    except OSError as err:
        say(f"   Could not start autorun: {err}")


def install(host: str, port: int, here: bool, quiet: bool = False) -> int:
    if not quiet:
        say()
        say("  Hoza YT - autorun setup")
        say("  =======================")

    source = HERE
    target = source if here else INSTALL_DIR

    say()
    say("-- Checking Python")
    say(f"   Python {sys.version.split()[0]} at {sys.executable}")
    if not ensure_dependencies(source):
        return 1

    say()
    say("-- Clearing the old always-on setup")
    clear_legacy()
    for pid in processes_running("autorun.py"):
        kill(pid, "a running autorun")

    if target != source:
        say()
        say("-- Copying the server to its own folder")
        copy_server(source, target)

    script = target / "autorun.py"
    if not script.exists():
        say(f"   Missing {script}")
        return 1

    say()
    say("-- Registering it to start at sign-in")
    by_task = register_task(script)
    if not by_task and not register_run_key(script):
        say()
        say("  Could not set it up by either method.")
        return 1
    if by_task:
        clear_run_key()

    say()
    say("-- Starting it now")
    start_now(script, by_task)

    if quiet:
        say(f"   Set up. The server now comes and goes with your browser, "
            f"from {target}.")
        return 0

    # With a browser already open the server should follow within seconds. With
    # none open, autorun is doing its job by staying quiet, so waiting for a
    # reply would be waiting for something that must not happen.
    say()
    if browser_running():
        say("   A browser is open, so the server should answer. Checking...")
        if wait_until_healthy(host, port, 80):
            say("  Done. The server is running now.")
        else:
            say("  Autorun is installed, but the server has not answered yet.")
            say("  It may still be starting. Look at what it is doing with:")
            say(f"    python autorun.py --status")
            say(f"    type \"{target / 'data' / 'autorun.log'}\"")
    else:
        say("  Done. No browser is open, so nothing is running yet.")

    say()
    say("  From now on, by itself:")
    say("    - the server starts a few seconds after you open a browser")
    say(f"    - it stops about {BROWSER_GRACE_SECONDS}s after you close the last browser window")
    say("    - a download still in progress keeps it open until it finishes")
    say("    - if it ever crashes or hangs it is started again")
    say()
    say(f"  Running from  {target}")
    say(f"  Dashboard     http://{host}:{port}/")
    say()
    if target != source:
        say("  After editing the project, run this again to update the copy:")
        say(f"    python \"{source / 'autorun.py'}\" --install")
        say()
    say("  Undo all of it with:  python autorun.py --uninstall")
    say()
    return 0


def already_installed() -> bool:
    """True if autorun is already registered to start on its own."""
    code, _ = run_quiet(["schtasks", "/Query", "/TN", TASK_NAME])
    if code == 0:
        return True
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.QueryValueEx(key, RUN_VALUE)
        return True
    except (ImportError, OSError):
        return False


def bootstrap(host: str, port: int) -> None:
    """Set autorun up the first time the server is ever started.

    A browser extension cannot launch a program, so one local run has to
    happen before anything can be automatic. This makes that run the only one:
    however the server first comes up -- by hand, from the project, from
    anywhere -- it arranges never to need starting again, and there is no
    install command for anyone to remember.

    `server.py` calls this in the background. Once autorun is registered, which
    is the usual case from the second run onwards, it notices in milliseconds
    and does nothing. Set HOZA_NO_BOOTSTRAP=1 to keep it out of the way.
    """
    if os.name != "nt" or os.environ.get("HOZA_NO_BOOTSTRAP"):
        return
    if already_installed():
        return

    # Wait for this server to answer first. Starting autorun any earlier would
    # have it find nothing on the port and spawn a second server, which would
    # then lose the race for it and die.
    if not wait_until_healthy(host, port, STARTUP_GRACE_SECONDS):
        return

    say()
    say("  First run: setting Hoza YT up so it never has to be started again.")
    try:
        install(host, port, here=False, quiet=True)
    except Exception as err:
        # Setting up is a courtesy. Failing at it must not take the server down.
        say(f"  Automatic setup did not finish: {err}")


def uninstall(host: str, port: int) -> int:
    say()
    say("  Hoza YT - removing autorun")
    say("  ==========================")
    say()

    code, _ = run_quiet(["schtasks", "/Query", "/TN", TASK_NAME])
    if code == 0:
        run_quiet(["schtasks", "/Delete", "/TN", TASK_NAME, "/F"])
        say("   Scheduled task removed")
    else:
        say("   No scheduled task was registered")

    if clear_run_key():
        say("   Sign-in registry entry removed")

    for pid in processes_running("autorun.py"):
        kill(pid, "autorun")

    # Autorun would normally take the server with it, but it was just stopped
    # outright, so the port is cleared here instead.
    if port_holders(port):
        clear_port(port)
    say()
    say("  Done. Nothing starts on its own any more.")
    say(f"  Start the server by hand with:  python server.py")
    say("  Put autorun back with:          python autorun.py --install")
    say()
    return 0


def stop_everything(host: str, port: int) -> int:
    """Stop autorun and the server right now, leaving the setup in place."""
    stopped = False
    for pid in processes_running("autorun.py"):
        kill(pid, "autorun")
        stopped = True
    if port_holders(port):
        clear_port(port)
        stopped = True

    if not stopped:
        say("Nothing was running.")
        return 0

    code, _ = run_quiet(["schtasks", "/Query", "/TN", TASK_NAME])
    if code == 0:
        say("Stopped. The sign-in task will start it again within ten minutes,")
        say("or at your next sign-in. Remove it with:  python autorun.py --uninstall")
    else:
        say("Stopped.")
    return 0


def update_yt_dlp() -> int:
    """YouTube changes often; this is the fix when links start failing."""
    say("Updating yt-dlp...")
    done = subprocess.run([sys.executable, "-m", "pip", "install", "--upgrade", "yt-dlp"])
    if done.returncode != 0:
        say("The update failed.")
        return 1
    say("Done. Restart the server to pick it up:  python autorun.py --stop")
    return 0


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def report(host: str, port: int) -> int:
    """One-shot status, for a person or a caller that wants a yes or no."""
    up = healthy(host, port)
    holders = port_holders(port)
    code, _ = run_quiet(["schtasks", "/Query", "/TN", TASK_NAME])

    print(f"browser  : {'open' if browser_running() else 'none open'}")
    print(f"server   : {'online' if up else 'not answering'} at http://{host}:{port}")
    print(f"port {port}: {', '.join(f'pid {p}' for p in holders) or 'nothing listening'}")
    try:
        held = json.loads(LOCK_PATH.read_text(encoding="utf-8")).get("pid")
        alive = _pid_alive(held) if isinstance(held, int) else False
        print(f"autorun  : {'running' if alive else 'stale lock'} (pid {held})")
    except (OSError, ValueError):
        print("autorun  : not running")
    print(f"start-up : {'scheduled task' if code == 0 else 'no scheduled task'}")
    print(f"folder   : {HERE}")
    print(f"log      : {LOG_PATH}")
    return 0 if up else 1


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the Hoza YT server for as long as a browser is open")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--install", action="store_true",
                        help="set it up to start at sign-in, and start it now")
    parser.add_argument("--here", action="store_true",
                        help="with --install: run from this folder rather than "
                             "copying the server to LOCALAPPDATA")
    parser.add_argument("--uninstall", action="store_true",
                        help="undo --install and stop everything")
    parser.add_argument("--stop", action="store_true",
                        help="stop the server and autorun now")
    parser.add_argument("--update", action="store_true",
                        help="update yt-dlp")
    parser.add_argument("--status", action="store_true",
                        help="report once and exit")
    parser.add_argument("--follow", action=argparse.BooleanOptionalAction,
                        default=True,
                        help="stop the server when the last browser closes")
    args = parser.parse_args()

    if args.install:
        return install(args.host, args.port, args.here)
    if args.uninstall:
        return uninstall(args.host, args.port)
    if args.stop:
        return stop_everything(args.host, args.port)
    if args.update:
        return update_yt_dlp()
    if args.status:
        return report(args.host, args.port)

    if not claim_lock():
        return 0

    runner = Autorun(args.host, args.port, follow=args.follow)
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, runner.stop)
        except (ValueError, OSError):
            pass

    try:
        return runner.run()
    finally:
        release_lock()


if __name__ == "__main__":
    sys.exit(main())
