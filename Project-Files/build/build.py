"""Build the Hoza YT Windows installer.

    python build/build.py                 everything, ending in the .exe
    python build/build.py --no-installer  stop after the engine and extension
    python build/build.py --skip-engine   reuse the last engine build
    python build/build.py --no-ffmpeg     a much smaller build, no media tools

The product version comes from manifest.json and is stamped everywhere else, so
there is exactly one number to change for a release.

Output:

    dist/HozaYT/            the engine, as the installer will lay it down
    dist/extension/         the production extension
    dist/HozaYT-Setup.exe   the installer
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "build"
DIST = ROOT / "dist"
WORK = BUILD / "work"

ENGINE_OUT = DIST / "HozaYT"
EXTENSION_OUT = DIST / "extension"

PUBLISHER = "Rahoz Osman"
PRODUCT = "Hoza YT"

# Inno Setup, wherever this machine happens to keep it.
ISCC_CANDIDATES = (
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs/Inno Setup 6/ISCC.exe",
    Path(r"C:\Program Files (x86)\Inno Setup 6\ISCC.exe"),
    Path(r"C:\Program Files\Inno Setup 6\ISCC.exe"),
    Path(r"C:\Program Files\Inno Setup 7\ISCC.exe"),
    Path(r"C:\Program Files (x86)\Inno Setup 7\ISCC.exe"),
)

# What is redistributed inside the installer, and where its source lives. The
# notices file is generated from this, so adding a dependency without saying
# where it came from is not possible.
REDISTRIBUTED = {
    "fastapi": "https://github.com/fastapi/fastapi",
    "starlette": "https://github.com/encode/starlette",
    "uvicorn": "https://github.com/encode/uvicorn",
    "pydantic": "https://github.com/pydantic/pydantic",
    "httpx": "https://github.com/encode/httpx",
    "httpcore": "https://github.com/encode/httpcore",
    "h11": "https://github.com/python-hyper/h11",
    "anyio": "https://github.com/agronholm/anyio",
    "certifi": "https://github.com/certifi/python-certifi",
    "idna": "https://github.com/kjd/idna",
    "psutil": "https://github.com/giampaolo/psutil",
    "yt-dlp": "https://github.com/yt-dlp/yt-dlp",
    "imageio-ffmpeg": "https://github.com/imageio/imageio-ffmpeg",
    "websockets": "https://github.com/python-websockets/websockets",
}


def say(message: str = "") -> None:
    print(message, flush=True)


def step(title: str) -> None:
    say()
    say(f"-- {title}")


def run(command: list[str], **kwargs) -> None:
    done = subprocess.run(command, cwd=str(ROOT), **kwargs)
    if done.returncode != 0:
        raise SystemExit(f"\nFailed: {' '.join(str(part) for part in command)}")


# --------------------------------------------------------------------------- #
# Version
# --------------------------------------------------------------------------- #

def product_version() -> str:
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = str(manifest["version"])
    parts = version.split(".")
    if not (2 <= len(parts) <= 4) or not all(part.isdigit() for part in parts):
        raise SystemExit(f"manifest.json has a version Windows cannot use: {version}")
    return version


def stamp_version(version: str) -> None:
    """Put the product version everywhere that reports one."""
    for target, pattern in (
        (ROOT / "native-host/hozayt/__init__.py", '__version__ = "'),
        (ROOT / "server/app/__init__.py", '__version__ = "'),
    ):
        text = target.read_text(encoding="utf-8")
        start = text.index(pattern) + len(pattern)
        end = text.index('"', start)
        current = text[start:end]
        if current == version:
            continue
        target.write_text(text[:start] + version + text[end:], encoding="utf-8")
        say(f"   {target.relative_to(ROOT)}: {current} -> {version}")


def write_version_resource(version: str) -> None:
    """The VERSIONINFO block Windows shows in the file's properties."""
    parts = [int(p) for p in version.split(".")]
    while len(parts) < 4:
        parts.append(0)
    quad = ", ".join(str(p) for p in parts[:4])

    (BUILD / "version-info.txt").write_text(
        f"""VSVersionInfo(
  ffi=FixedFileInfo(
    filevers=({quad}),
    prodvers=({quad}),
    mask=0x3f, flags=0x0, OS=0x40004, fileType=0x1, subtype=0x0,
    date=(0, 0)
  ),
  kids=[
    StringFileInfo([
      StringTable('040904B0', [
        StringStruct('CompanyName', '{PUBLISHER}'),
        StringStruct('FileDescription', '{PRODUCT} local engine'),
        StringStruct('FileVersion', '{version}'),
        StringStruct('InternalName', 'HozaYT'),
        StringStruct('LegalCopyright', 'Copyright (c) {time.gmtime().tm_year} {PUBLISHER}'),
        StringStruct('OriginalFilename', 'HozaYT.exe'),
        StringStruct('ProductName', '{PRODUCT}'),
        StringStruct('ProductVersion', '{version}')])
    ]),
    VarFileInfo([VarStruct('Translation', [1033, 1200])])
  ]
)
""",
        encoding="utf-8",
    )


# --------------------------------------------------------------------------- #
# Icon
#
# A Windows .ico is a directory of images, and since Vista each of those images
# may simply be a PNG. The project already ships the four sizes, so the icon is
# assembled from them rather than being another binary to keep in the tree.
# --------------------------------------------------------------------------- #

def build_icon() -> Path:
    target = ROOT / "installer/assets/hozayt.ico"
    target.parent.mkdir(parents=True, exist_ok=True)

    sources = []
    for size in (16, 32, 48, 128):
        png = ROOT / f"icons/icon-{size}.png"
        if png.exists():
            sources.append((size, png.read_bytes()))
    if not sources:
        raise SystemExit("No icons/icon-*.png to build the application icon from.")

    header = struct.pack("<HHH", 0, 1, len(sources))
    offset = len(header) + 16 * len(sources)
    directory = b""
    payload = b""
    for size, data in sources:
        directory += struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0,
            size if size < 256 else 0,
            0, 0, 1, 32, len(data), offset,
        )
        payload += data
        offset += len(data)

    target.write_bytes(header + directory + payload)
    say(f"   {target.relative_to(ROOT)} ({len(sources)} sizes)")
    return target


# --------------------------------------------------------------------------- #
# The release folder
# --------------------------------------------------------------------------- #

def stage_release() -> None:
    """Stage dist/release: the two things a user touches, in order.

    Delegated to build/release.py so it can also be run on its own against an
    existing dist/, which is what you want when only the wording changed.
    """
    import release

    if release.stage() != 0:
        raise SystemExit("The release folder could not be staged.")


# --------------------------------------------------------------------------- #
# The extension
# --------------------------------------------------------------------------- #

EXTENSION_ITEMS = ("manifest.json", "src", "icons")


def build_extension(version: str) -> None:
    if EXTENSION_OUT.exists():
        shutil.rmtree(EXTENSION_OUT)
    EXTENSION_OUT.mkdir(parents=True)

    for name in EXTENSION_ITEMS:
        source = ROOT / name
        destination = EXTENSION_OUT / name
        if source.is_dir():
            shutil.copytree(source, destination,
                            ignore=shutil.ignore_patterns("__pycache__", "*.map"))
        else:
            shutil.copy2(source, destination)

    manifest = json.loads((EXTENSION_OUT / "manifest.json").read_text(encoding="utf-8"))
    if manifest["version"] != version:
        raise SystemExit("The staged manifest disagrees with the product version.")
    if not manifest.get("key"):
        raise SystemExit(
            "manifest.json has no \"key\". Without one the extension's id changes\n"
            "with its location, and the native host cannot be registered for it."
        )

    files = sum(1 for item in EXTENSION_OUT.rglob("*") if item.is_file())
    say(f"   {files} file(s) -> {EXTENSION_OUT.relative_to(ROOT)}")


def extension_id() -> str:
    """The id Chrome will give this extension, derived from its manifest key."""
    import base64
    import hashlib

    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    digest = hashlib.sha256(base64.b64decode(manifest["key"])).hexdigest()[:32]
    return "".join(chr(ord("a") + int(char, 16)) for char in digest)


# --------------------------------------------------------------------------- #
# The engine
# --------------------------------------------------------------------------- #

def build_engine(with_ffmpeg: bool) -> None:
    if ENGINE_OUT.exists():
        shutil.rmtree(ENGINE_OUT)

    environment = dict(os.environ)
    environment["HOZA_BUILD_ROOT"] = str(ROOT)
    environment["HOZA_BUNDLE_FFMPEG"] = "1" if with_ffmpeg else "0"

    run(
        [
            sys.executable, "-m", "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath", str(DIST),
            "--workpath", str(WORK),
            "--log-level", "WARN",
            str(BUILD / "hozayt.spec"),
        ],
        env=environment,
    )

    executable = ENGINE_OUT / "HozaYT.exe"
    if not executable.exists():
        raise SystemExit("PyInstaller finished but produced no HozaYT.exe.")

    size = sum(f.stat().st_size for f in ENGINE_OUT.rglob("*") if f.is_file())
    say(f"   {ENGINE_OUT.relative_to(ROOT)} ({size / 1024 / 1024:.0f} MB)")


def bundle_extension_with_engine() -> None:
    """The installer lays the extension down beside the engine.

    That is what lets the setup page point at a real folder, and what makes the
    uninstaller able to take it away again.
    """
    target = ENGINE_OUT / "extension"
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(EXTENSION_OUT, target)
    say(f"   extension -> {target.relative_to(ROOT)}")


# --------------------------------------------------------------------------- #
# Licences
#
# Everything redistributed is named, with its version, its declared licence and
# where its source is. Licence texts are copied from the packages themselves
# rather than written out here, so what ships is what the authors published.
# --------------------------------------------------------------------------- #

def collect_licences(with_ffmpeg: bool) -> None:
    from importlib import metadata

    licences = ENGINE_OUT / "licenses"
    if licences.exists():
        shutil.rmtree(licences)
    licences.mkdir(parents=True)

    lines = [
        f"{PRODUCT} -- third-party notices",
        "=" * 60,
        "",
        "This application is distributed with the components below. Each keeps",
        "its own licence; copies of those licences are in this folder.",
        "",
    ]

    copied = 0
    for name, source_url in sorted(REDISTRIBUTED.items()):
        try:
            distribution = metadata.distribution(name)
        except metadata.PackageNotFoundError:
            continue
        version = distribution.version
        declared = (
            distribution.metadata.get("License-Expression")
            or distribution.metadata.get("License")
            or "; ".join(
                value.split("::")[-1].strip()
                for value in distribution.metadata.get_all("Classifier") or []
                if value.startswith("License ::")
            )
            or "see the licence file"
        )
        lines += [
            f"{name} {version}",
            f"    licence : {declared.splitlines()[0][:100]}",
            f"    source  : {source_url}",
            "",
        ]

        folder = licences / name
        for item in distribution.files or []:
            base = Path(item.name).name.lower()
            if base.startswith(("license", "licence", "copying", "notice")):
                try:
                    text = distribution.locate_file(item)
                    folder.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(text, folder / Path(item.name).name)
                    copied += 1
                except OSError:
                    pass

    if with_ffmpeg:
        import imageio_ffmpeg

        lines += [
            "FFmpeg",
            f"    build   : {imageio_ffmpeg.get_ffmpeg_version()}",
            "    licence : GPL. FFmpeg is redistributed here as a separate,",
            "              unmodified executable that this application starts as",
            "              its own process. It is not linked into, and does not",
            "              share an address space with, any part of Hoza YT.",
            "    source  : https://ffmpeg.org/download.html",
            "              https://www.gyan.dev/ffmpeg/builds/  (this build)",
            "    licence text and configuration: https://ffmpeg.org/legal.html",
            "",
        ]

    lines += [
        "Python",
        f"    version : {sys.version.split()[0]}",
        "    licence : PSF License Agreement",
        "    source  : https://www.python.org/downloads/source/",
        "",
    ]

    (ENGINE_OUT / "THIRD-PARTY-NOTICES.txt").write_text(
        "\n".join(lines), encoding="utf-8"
    )
    say(f"   {len(REDISTRIBUTED)} component(s) named, {copied} licence file(s) copied")


# --------------------------------------------------------------------------- #
# The installer
# --------------------------------------------------------------------------- #

def find_iscc() -> Path | None:
    for candidate in ISCC_CANDIDATES:
        if candidate.is_file():
            return candidate
    found = shutil.which("ISCC")
    return Path(found) if found else None


def build_installer(version: str) -> Path:
    compiler = find_iscc()
    if compiler is None:
        raise SystemExit(
            "Inno Setup was not found.\n"
            "Install it once with:  winget install JRSoftware.InnoSetup"
        )
    say(f"   using {compiler}")

    run([
        str(compiler),
        f"/DAppVersion={version}",
        f"/DExtensionId={extension_id()}",
        f"/DSourceRoot={ROOT}",
        f"/DOutputDir={DIST}",
        str(ROOT / "installer" / "HozaYT.iss"),
    ])

    installer = DIST / f"{PRODUCT.replace(' ', '')}-Setup.exe"
    if not installer.exists():
        raise SystemExit("Inno Setup finished but produced no installer.")
    return installer


# --------------------------------------------------------------------------- #

def main() -> int:
    parser = argparse.ArgumentParser(description="Build the Hoza YT installer")
    parser.add_argument("--no-installer", action="store_true",
                        help="build the engine and extension, but not the .exe")
    parser.add_argument("--skip-engine", action="store_true",
                        help="reuse the engine from the last build")
    parser.add_argument("--no-ffmpeg", action="store_true",
                        help="leave the media tools out, for a much smaller build")
    args = parser.parse_args()

    if sys.platform != "win32":
        say("This installer is for Windows, and has to be built on Windows.")
        return 1

    version = product_version()
    started = time.time()

    say()
    say(f"  {PRODUCT} {version} -- building the Windows installer")
    say("  " + "=" * 52)

    step("Version")
    stamp_version(version)
    write_version_resource(version)
    say(f"   product version {version}")
    say(f"   extension id    {extension_id()}")

    step("Icon")
    build_icon()

    step("Extension")
    build_extension(version)

    if args.skip_engine and ENGINE_OUT.exists():
        step("Engine (reused)")
        say(f"   {ENGINE_OUT.relative_to(ROOT)}")
    else:
        step("Engine")
        build_engine(with_ffmpeg=not args.no_ffmpeg)

    step("Packaging")
    bundle_extension_with_engine()
    collect_licences(with_ffmpeg=not args.no_ffmpeg)

    if args.no_installer:
        say()
        say(f"  Done in {time.time() - started:.0f}s. Installer not built (--no-installer).")
        return 0

    step("Installer")
    installer = build_installer(version)

    # What a person is actually handed: the setup program and the folder
    # Chrome is pointed at, and nothing else from dist/ to sift through.
    step("Release folder")
    stage_release()

    size = installer.stat().st_size / 1024 / 1024
    say()
    say("  " + "=" * 52)
    say(f"  {installer.relative_to(ROOT)}  ({size:.0f} MB)")
    say(f"  {(DIST / 'release').relative_to(ROOT)}  (give this to users)")
    say(f"  Built in {time.time() - started:.0f}s.")
    say()
    return 0


if __name__ == "__main__":
    sys.exit(main())
