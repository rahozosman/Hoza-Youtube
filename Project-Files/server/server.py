"""Hoza YT server launcher.

Starts the API and the dashboard on one local port.

    python server.py                 start and open the dashboard
    python server.py --no-browser    start without opening a browser
    python server.py --port 8766     run a second instance on another port

Running more than one instance is how the server list and failover are tested:
add the second instance's address on the Servers page of the first.
"""

from __future__ import annotations

import argparse
import os
import socket
import sys
import threading
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))


def _missing_dependencies() -> list[str]:
    missing = []
    for module, package in (
        ("fastapi", "fastapi"),
        ("uvicorn", "uvicorn[standard]"),
        ("yt_dlp", "yt-dlp"),
        ("httpx", "httpx"),
        ("psutil", "psutil"),
    ):
        try:
            __import__(module)
        except ImportError:
            missing.append(package)
    return missing


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind((host, port))
            return True
        except OSError:
            return False


def main() -> int:
    parser = argparse.ArgumentParser(description="Hoza YT server")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--reload", action="store_true", help="reload on code changes")
    parser.add_argument(
        "--data-dir",
        help="where this instance keeps its database and configuration. "
             "A second instance on the same machine needs its own.",
    )
    args = parser.parse_args()

    # Must be set before any app module is imported, since paths are resolved
    # at import time.
    if args.data_dir:
        os.environ["HOZA_DATA_DIR"] = args.data_dir

    missing = _missing_dependencies()
    if missing:
        print("Missing dependencies:", ", ".join(missing))
        print("Install them with:  python -m pip install -r requirements.txt")
        return 1

    if not _port_free(args.host, args.port):
        print(f"Port {args.port} is already in use.")
        print(f"Either the server is already running at http://{args.host}:{args.port}")
        print(f"or another program holds the port. Try:  python server.py --port {args.port + 1}")
        return 1

    import uvicorn

    from app import APP_NAME, __version__, config, ffmpeg as ffmpeg_mod, paths, servers

    paths.ensure_dirs()
    servers.set_port(args.port)
    settings = config.load()
    info = ffmpeg_mod.probe()
    url = f"http://{args.host}:{args.port}"

    print("=" * 66)
    print(f"  {APP_NAME} {__version__}")
    print(f"  Dashboard   {url}")
    print(f"  Downloads   {settings['general']['download_dir']}")
    print(f"  ffmpeg      {info.version or 'NOT FOUND'} ({info.source})")
    if info.available:
        print(f"  Audio out   {', '.join(info.audio_formats()) or 'none'}")
    print(f"  Database    {paths.DB_PATH}")
    print("  Stop with Ctrl+C")
    print("=" * 66)

    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()

    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        log_level="warning",
        access_log=False,
        reload=args.reload,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
