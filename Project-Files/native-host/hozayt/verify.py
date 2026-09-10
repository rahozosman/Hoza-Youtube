"""Proving the installation actually works, before telling anyone it does.

The installer runs this and shows the result. Every check is a real one: files
are opened, the registry is read, the backend is started, the health endpoint
is called, and the native host is spoken to over the same stdio protocol Chrome
uses. Nothing is assumed from the fact that a file was copied.

Failures are reported in words a person can act on. Nobody is ever told to open
a terminal.
"""

from __future__ import annotations

import json
import struct
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from . import (
    APP_NAME, EXTENSION_ORIGIN, NATIVE_HOST_NAME, __version__,
    net, places, procs, register, state,
)
from . import logbook as log


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    fix: str = ""

    def to_dict(self) -> dict:
        return {"name": self.name, "ok": self.ok, "detail": self.detail, "fix": self.fix}


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(check.ok for check in self.checks)

    def add(self, check: Check) -> Check:
        self.checks.append(check)
        log.info(f"{'PASS' if check.ok else 'FAIL'}  {check.name}"
                 + (f" -- {check.detail}" if check.detail else ""))
        return check

    def to_dict(self) -> dict:
        return {
            "ok": self.ok,
            "version": __version__,
            "checks": [check.to_dict() for check in self.checks],
        }


REINSTALL = f"Reinstalling {APP_NAME} restores the missing pieces."


# --------------------------------------------------------------------------- #
# The checks
# --------------------------------------------------------------------------- #

def check_files(report: Report) -> None:
    program = places.program_dir()
    required = [program / "HozaYT.exe"]
    missing = [str(item) for item in required if not item.exists()]
    report.add(Check(
        "Program files",
        not missing,
        f"{program}" if not missing else f"missing: {', '.join(missing)}",
        REINSTALL,
    ))


def check_registration(report: Report) -> None:
    keys = register.registered_for()
    manifest = register.manifest_path("chromium")
    detail = ""
    ok = bool(keys) and manifest.exists()
    if ok:
        try:
            document = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            document = {}
        origins = document.get("allowed_origins") or []
        path_ok = Path(str(document.get("path", ""))).exists()
        ok = EXTENSION_ORIGIN in origins and path_ok
        detail = f"{len(keys)} browser key(s), manifest names {len(origins)} origin(s)"
        if not path_ok:
            detail += "; the manifest points at a file that is not there"
    else:
        detail = "no browser is pointing at the Hoza YT host manifest"
    report.add(Check("Browser connection (native messaging)", ok, detail, REINSTALL))


def check_backend_present(report: Report) -> None:
    """The backend is a role of the same executable, so this asks whether that
    executable can actually enter it."""
    command = places.relaunch_command("--role-check")
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=60,
                              creationflags=procs.CREATE_NO_WINDOW)
        ok = done.returncode == 0 and "backend" in (done.stdout or "")
        detail = (done.stdout or done.stderr or "").strip().splitlines()
        detail = detail[-1] if detail else ""
    except (OSError, subprocess.SubprocessError) as err:
        ok, detail = False, str(err)
    report.add(Check("Local engine", ok, detail, REINSTALL))


def check_backend_starts(report: Report, timeout: float = 90.0) -> None:
    runtime = state.read()
    port = runtime.get("port")
    if isinstance(port, int) and net.serving(port, net.HOST, runtime.get("token")):
        report.add(Check("Local engine starts", True, f"already running on port {port}"))
        return

    child = procs.spawn_detached(
        places.relaunch_command("--supervisor"),
        cwd=str(places.program_dir()),
        env=procs.clean_environment(),
    )
    if child is None:
        report.add(Check("Local engine starts", False,
                         "the engine manager would not start", REINSTALL))
        return

    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1.0)
        runtime = state.read()
        port = runtime.get("port")
        if isinstance(port, int) and net.serving(port, net.HOST, runtime.get("token")):
            report.add(Check("Local engine starts", True,
                             f"ready on port {port} in "
                             f"{timeout - (deadline - time.time()):.0f}s"))
            return
        if runtime.get("state") == state.CRASHED:
            break

    report.add(Check(
        "Local engine starts", False,
        state.read().get("error") or "it did not answer in time",
        "Restart the computer and try again. If it keeps happening, "
        f"reinstall {APP_NAME}.",
    ))


def check_health(report: Report) -> None:
    runtime = state.read()
    port = runtime.get("port")
    if not isinstance(port, int):
        report.add(Check("Engine health", False, "the engine is not running", REINSTALL))
        return
    payload = net.health(port, net.HOST, runtime.get("token"), timeout=10.0)
    if not payload:
        report.add(Check("Engine health", False,
                         f"nothing answered on port {port}", REINSTALL))
        return
    status = payload.get("status")
    ok = status in {"online", "degraded"}
    detail = f"{status} on port {port}"
    fix = ""
    if status == "degraded":
        detail += " -- media conversion is unavailable"
        fix = f"Reinstalling {APP_NAME} restores the bundled media tools."
    report.add(Check("Engine health", ok, detail, fix))


def check_native_channel(report: Report) -> None:
    """Speak to the host exactly the way Chrome does, and read the answer.

    This is the check that proves the extension will work: same executable,
    same stdio framing, same origin argument.
    """
    executable = places.relaunch_command()[0] if places.frozen() else sys.executable
    command = places.relaunch_command(EXTENSION_ORIGIN)
    request = json.dumps({"action": "status"}).encode("utf-8")
    payload = struct.pack("<I", len(request)) + request

    try:
        done = subprocess.run(
            command,
            input=payload,
            capture_output=True,
            timeout=45,
            creationflags=procs.CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError) as err:
        report.add(Check("Extension channel", False, str(err), REINSTALL))
        return

    body = done.stdout or b""
    if len(body) < 4:
        report.add(Check("Extension channel", False,
                         "the host sent no reply", REINSTALL))
        return
    (size,) = struct.unpack("<I", body[:4])
    try:
        answer = json.loads(body[4:4 + size].decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        report.add(Check("Extension channel", False,
                         "the host sent a reply that could not be read", REINSTALL))
        return

    ok = isinstance(answer, dict) and "state" in answer
    report.add(Check(
        "Extension channel", ok,
        f"the host answered: {answer.get('state', 'unknown')}" if ok
        else "the host answered with something unexpected",
        REINSTALL,
    ))


def check_extension_seen(report: Report) -> None:
    """Whether the extension has actually said hello yet.

    This one is informational at install time: nobody has opened the browser
    yet. It becomes the real answer when the setup page runs it later.
    """
    runtime = state.read()
    port = runtime.get("port")
    payload = net.health(port, net.HOST, runtime.get("token"), timeout=5.0) \
        if isinstance(port, int) else None
    seen = bool((payload or {}).get("extension_seen"))
    report.add(Check(
        "Extension connected", seen,
        "the extension has been in touch" if seen
        else "waiting for the extension -- open your browser to finish",
        "Open Chrome and follow the short setup page.",
    ))


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def run(*, quick: bool = False, include_extension: bool = False) -> Report:
    log.bind("verify")
    places.ensure_dirs()
    report = Report()

    check_files(report)
    check_registration(report)
    check_backend_present(report)
    if not quick:
        check_backend_starts(report)
        check_health(report)
    check_native_channel(report)
    if include_extension:
        check_extension_seen(report)
    return report


def main(argv: list[str]) -> int:
    as_json = "--json" in argv
    quick = "--quick" in argv
    report = run(quick=quick, include_extension="--with-extension" in argv)

    if as_json:
        print(json.dumps(report.to_dict(), indent=2))
    else:
        print()
        print(f"  {APP_NAME} {__version__} -- installation check")
        print("  " + "-" * 48)
        for check in report.checks:
            mark = "OK  " if check.ok else "FAIL"
            print(f"  [{mark}] {check.name}")
            if check.detail:
                print(f"         {check.detail}")
            if not check.ok and check.fix:
                print(f"         {check.fix}")
        print()
        print("  Everything is working." if report.ok
              else "  Something needs attention -- see above.")
        print(f"  Logs: {places.log_dir()}")
        print()
    return 0 if report.ok else 1
