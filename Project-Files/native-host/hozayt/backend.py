"""The packaged backend: the same FastAPI application, started without Python.

Development still runs `python server/server.py`, and that path is untouched.
This is the production equivalent: no console, no arguments to get wrong, and
every setting arriving from the supervisor through the environment so there is
nothing for a user to configure.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from . import places
from . import logbook as log


def _prepare_import_path() -> None:
    """Make the `app` package importable in both builds.

    Packaged, PyInstaller has already put it in the bundle. From a checkout it
    lives in `server/`, which is not on the path of a process started from the
    repository root.
    """
    directory = str(places.server_dir())
    if directory not in sys.path:
        sys.path.insert(0, directory)


def _bundled_ffmpeg() -> str | None:
    """The media tools that shipped with this installation, if they did.

    A build made with --no-ffmpeg has none, and the application says so on its
    own: the dashboard reports "degraded" and offers no conversions it cannot
    perform.
    """
    root = Path(getattr(sys, "_MEIPASS", "")) if places.frozen() else None
    if root is None:
        return None
    for candidate in (root / "imageio_ffmpeg" / "binaries").glob("ffmpeg*.exe"):
        return str(candidate)
    return None


def main() -> int:
    log.bind("backend")
    log.install_excepthook()
    places.ensure_dirs()
    _prepare_import_path()

    host = os.environ.get("HOZA_HOST", "127.0.0.1")
    try:
        port = int(os.environ.get("HOZA_PORT", "8765"))
    except ValueError:
        port = 8765

    # Must be set before any app module is imported: the paths module resolves
    # its roots at import time.
    os.environ.setdefault("HOZA_DATA_DIR", str(places.backend_data_dir()))
    os.environ.setdefault("HOZA_NO_BOOTSTRAP", "1")

    bundled = _bundled_ffmpeg()
    if bundled:
        os.environ.setdefault("HOZA_FFMPEG", bundled)
        # imageio_ffmpeg reads this one, and the analyzer reaches it through
        # that package rather than through our probe.
        os.environ.setdefault("IMAGEIO_FFMPEG_EXE", bundled)

    try:
        import uvicorn

        from app import paths as app_paths
        from app import servers as app_servers
        from app.main import app as application
    except Exception:
        log.exception("The backend could not be loaded.")
        return 1

    app_paths.ensure_dirs()
    # The supervisor chose the port, so the application's own idea of its
    # address has to come from here rather than from a default.
    app_servers.set_port(port)
    log.info(f"Backend listening on http://{host}:{port}")

    try:
        uvicorn.run(
            application,
            host=host,
            port=port,
            log_level="warning",
            access_log=False,
        )
    except Exception:
        log.exception("The backend stopped with an unhandled error.")
        return 1
    log.info("Backend stopped.")
    return 0
