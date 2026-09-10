"""Role dispatch.

Chrome decides the command line when it starts a native messaging host: it
passes the calling extension's origin and, on Windows, a parent window handle,
and it accepts no arguments of ours. So the product ships one executable and
works out from its own arguments which part of itself to be.

    HozaYT.exe                            open the dashboard (Start menu)
    HozaYT.exe chrome-extension://<id>/   the native messaging host (Chrome)
    HozaYT.exe --supervisor               the backend manager
    HozaYT.exe --backend                  the backend itself
    HozaYT.exe --verify [--json]          check the installation (installer)
    HozaYT.exe --register / --unregister  browser registration (installer)
    HozaYT.exe --stop                     stop the engine (uninstaller)
    HozaYT.exe --diagnose                 a full report for a developer
"""

from __future__ import annotations

import json
import sys
import time
import webbrowser

from . import APP_NAME, __version__, net, places, procs, state
from . import logbook as log

ROLES = ("host", "supervisor", "backend", "verify", "register", "diagnose")


def _flag(argv: list[str], name: str) -> bool:
    return name in argv


def _is_host_invocation(argv: list[str]) -> bool:
    return any(arg.startswith(("chrome-extension://", "moz-extension://"))
               for arg in argv)


# --------------------------------------------------------------------------- #
# Small roles
# --------------------------------------------------------------------------- #

def stop_everything() -> int:
    """Stop the supervisor and the backend. Used by the uninstaller."""
    log.bind("verify")
    stopped = []

    try:
        held = json.loads(places.lock_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        held = {}
    if procs.stop(held.get("pid"), exe=held.get("exe"), what="the engine manager"):
        stopped.append("engine manager")

    runtime = state.read()
    if procs.stop(runtime.get("pid"), what="the engine"):
        stopped.append("engine")

    # Give a supervisor that is shutting down its child a moment to finish.
    for _ in range(20):
        port = state.read().get("port")
        if not isinstance(port, int) or not net.is_ours(port):
            break
        time.sleep(0.25)

    state.clear()
    try:
        places.lock_path().unlink(missing_ok=True)
    except OSError:
        pass
    print(f"Stopped: {', '.join(stopped) or 'nothing was running'}")
    return 0


def open_dashboard() -> int:
    """Start the engine if it is not up, then show the dashboard."""
    from .host import start_supervisor

    log.bind("verify")
    places.ensure_dirs()

    runtime = state.read()
    port = runtime.get("port")
    if not (isinstance(port, int) and net.serving(port, net.HOST, runtime.get("token"))):
        start_supervisor()
        deadline = time.time() + 60
        while time.time() < deadline:
            time.sleep(0.5)
            runtime = state.read()
            port = runtime.get("port")
            if isinstance(port, int) and net.serving(port, net.HOST, runtime.get("token")):
                break
        else:
            print(f"{APP_NAME} could not start. See {places.log_dir()}.")
            return 1

    webbrowser.open(f"http://{net.HOST}:{port}/")
    return 0


def open_setup() -> int:
    """Show the page that walks the user through the last browser step."""
    from .host import start_supervisor

    log.bind("verify")
    places.ensure_dirs()
    runtime = state.read()
    port = runtime.get("port")
    if not (isinstance(port, int) and net.serving(port, net.HOST, runtime.get("token"))):
        start_supervisor()
        deadline = time.time() + 60
        while time.time() < deadline:
            time.sleep(0.5)
            runtime = state.read()
            port = runtime.get("port")
            if isinstance(port, int) and net.serving(port, net.HOST, runtime.get("token")):
                break
    port = state.read().get("port")
    if not isinstance(port, int):
        return 1
    from . import browsers

    return 0 if browsers.open_setup_page(f"http://{net.HOST}:{port}/setup") else 1


def diagnose() -> int:
    """Everything a developer needs, in one place, without a debugger."""
    from . import register as registration
    from . import verify as verification

    print(f"{APP_NAME} {__version__}")
    print(f"  frozen        {places.frozen()}")
    print(f"  program       {places.program_dir()}")
    print(f"  data          {places.data_dir()}")
    print(f"  logs          {places.log_dir()}")
    print(f"  executable    {sys.executable}")
    print(f"  python        {sys.version.split()[0]}")
    print()
    print("  runtime state")
    runtime = dict(state.read())
    if runtime.get("token"):
        runtime["token"] = f"<{len(runtime['token'])} characters, hidden>"
    for key, value in sorted(runtime.items()):
        print(f"    {key:<12} {value}")
    print()
    print("  browser registration")
    for key in registration.registered_for() or ["    (none)"]:
        print(f"    {key}")
    print()
    report = verification.run()
    for check in report.checks:
        print(f"  [{'OK  ' if check.ok else 'FAIL'}] {check.name}: {check.detail}")
    return 0 if report.ok else 1


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)

    # Chrome first: it is the only caller that does not control its arguments.
    if _is_host_invocation(argv):
        from . import host

        return host.main(argv)

    if _flag(argv, "--supervisor"):
        from . import supervisor

        return supervisor.main(follow_browser=not _flag(argv, "--no-follow"))

    if _flag(argv, "--backend"):
        from . import backend

        return backend.main()

    if _flag(argv, "--verify"):
        from . import verify

        return verify.main(argv)

    if _flag(argv, "--register"):
        from . import register

        log.bind("verify")
        register.clear_legacy_autostart()
        ok = register.register()
        register.register_webstore()
        print("Registered." if ok else "Registration failed.")
        return 0 if ok else 1

    if _flag(argv, "--unregister"):
        from . import register

        log.bind("verify")
        register.unregister()
        print("Unregistered.")
        return 0

    if _flag(argv, "--stop"):
        return stop_everything()

    if _flag(argv, "--setup"):
        return open_setup()

    if _flag(argv, "--diagnose"):
        return diagnose()

    if _flag(argv, "--role-check"):
        # A cheap proof that this executable can reach every role it needs,
        # used by the installation check.
        try:
            from . import backend, host, supervisor  # noqa: F401
        except Exception as err:  # noqa: BLE001
            print(f"role import failed: {err}")
            return 1
        print(" ".join(ROLES))
        return 0

    if _flag(argv, "--version"):
        print(f"{APP_NAME} {__version__}")
        return 0

    return open_dashboard()


if __name__ == "__main__":
    sys.exit(main())
