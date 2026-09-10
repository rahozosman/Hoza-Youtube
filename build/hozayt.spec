# PyInstaller specification for the Hoza YT local engine.
#
# One executable in one folder. Every role -- native messaging host, backend
# manager, backend -- is the same binary entered with different arguments,
# because Chrome chooses the command line when it starts a native host and
# accepts none of ours.
#
# Built through build/build.py, which sets the version and the ffmpeg choice
# before calling PyInstaller.

import os
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(os.environ["HOZA_BUILD_ROOT"]).resolve()
WITH_FFMPEG = os.environ.get("HOZA_BUNDLE_FFMPEG", "1") == "1"

NATIVE = ROOT / "native-host"
SERVER = ROOT / "server"

# --------------------------------------------------------------------------- #
# What has to travel with the code
# --------------------------------------------------------------------------- #

datas = [
    # The dashboard the backend serves.
    (str(SERVER / "static"), "static"),
    # The window icon and the favicon the dashboard asks for.
    (str(ROOT / "icons"), "icons"),
]

# yt-dlp reaches for these at runtime and PyInstaller cannot see the reference.
datas += collect_data_files("yt_dlp", includes=["*.json", "*.txt"])

binaries = []
if WITH_FFMPEG:
    # The media engine. Invoked as a separate process, never linked, which is
    # what keeps its licence its own -- see THIRD-PARTY-NOTICES.txt.
    import imageio_ffmpeg

    ffmpeg = Path(imageio_ffmpeg.get_ffmpeg_exe())
    binaries.append((str(ffmpeg), f"imageio_ffmpeg/binaries"))

# --------------------------------------------------------------------------- #
# What the analyser cannot infer
# --------------------------------------------------------------------------- #

hiddenimports = [
    # The application, reached only through a string in the backend role.
    "app",
    "app.main",
    "app.analyzer",
    "app.downloader",
    "app.jobs",
    "app.servers",
    "app.session",
    # uvicorn resolves its loop and protocol implementations by name.
    *collect_submodules("uvicorn"),
    # httpx picks a transport at runtime.
    "httpx",
    "h11",
    "anyio",
    "sniffio",
    # imageio_ffmpeg is imported lazily by the ffmpeg probe.
    "imageio_ffmpeg",
    "psutil",
]

hookspath = []
try:
    import yt_dlp.__pyinstaller

    hookspath += yt_dlp.__pyinstaller.get_hook_dirs()
except Exception:
    # Without the hook, fall back to sweeping the extractors in by hand.
    hiddenimports += collect_submodules("yt_dlp")

# Nothing here needs a GUI toolkit, a plotting library or a test runner, and
# each one costs tens of megabytes in the installer.
excludes = [
    "tkinter", "test", "unittest", "pydoc_data", "lib2to3",
    "matplotlib", "numpy", "PIL", "PySide6", "PyQt5", "IPython",
    "setuptools", "pip", "wheel", "pytest",
]


a = Analysis(
    [str(ROOT / "build" / "entry.py")],
    pathex=[str(NATIVE), str(SERVER)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=hookspath,
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    noarchive=False,
    optimize=0,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="HozaYT",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    # A console subsystem is required: native messaging is stdio, and a
    # windowed build has no valid standard handles to read Chrome's pipe from.
    # Chrome launches native hosts hidden, so no window is ever shown, and
    # every internal relaunch passes CREATE_NO_WINDOW.
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=str(ROOT / "installer" / "assets" / "hozayt.ico"),
    version=str(ROOT / "build" / "version-info.txt"),
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="HozaYT",
)
