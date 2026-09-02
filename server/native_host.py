"""Native-messaging launcher for the Hoza YT local app."""

from __future__ import annotations

import json
import struct
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
DETACHED_PROCESS = getattr(subprocess, "DETACHED_PROCESS", 0)


def read_message() -> dict:
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        return {}
    size = struct.unpack("<I", header)[0]
    if size > 1024 * 1024:
        return {}
    try:
        value = json.loads(sys.stdin.buffer.read(size).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def start() -> None:
    python = Path(sys.executable)
    pythonw = python.with_name("pythonw.exe")
    executable = str(pythonw if pythonw.exists() else python)
    subprocess.Popen(
        [executable, str(HERE / "autorun.py"), "--no-follow"],
        cwd=str(HERE),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW | DETACHED_PROCESS,
        close_fds=True,
    )


def main() -> int:
    if read_message().get("action") == "start":
        try:
            start()
        except OSError:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())