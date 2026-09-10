"""Stage the folder a user actually receives.

The build leaves several things in `dist/`, and most of them are nobody's
business: the unpacked engine the installer swallows, its `_internal`, the
staged extension the installer also swallows. Handing that folder to someone
and expecting them to know which two items matter is how a working product
gets a reputation for being confusing.

So this stages a separate tree containing exactly what a person has to touch,
in the order they touch it, named so that the order is the name:

    dist/release/
        START HERE.txt
        1 - Install the app/           HozaYT-Setup.exe
        2 - Chrome extension/          the folder Chrome is pointed at

Two things, one of which is a double-click and the other of which is a folder
picker. Everything else the product needs, the installer does on its own.

    python build/release.py

It copies from `dist/`, so run it after `build/build.py`. Nothing here builds.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

SETUP_EXE = DIST / "HozaYT-Setup.exe"
EXTENSION_IN = DIST / "extension"

RELEASE = DIST / "release"
APP_DIR = RELEASE / "1 - Install the app"
EXT_DIR = RELEASE / "2 - Chrome extension"

# Windows reads .txt with CRLF; Notepad on older builds shows LF as one long
# line, and this file is the first thing anyone opens.
CRLF = "\r\n"


def say(message: str) -> None:
    print(message, flush=True)


def guide(version: str, extension_id: str) -> str:
    return CRLF.join((
        f"Hoza YT {version}",
        "=" * 40,
        "",
        "There are two steps. The first is a double-click. The second is",
        "choosing a folder. Nothing else is asked of you.",
        "",
        "",
        "STEP 1 - Install the app",
        "-" * 40,
        "",
        'Open the folder "1 - Install the app" and run HozaYT-Setup.exe.',
        "",
        "That is the whole step. The installer connects Hoza YT to your",
        "browser, starts the engine and checks that it works. The app then",
        "starts by itself whenever it is needed - you never have to launch",
        "it, and there is nothing to configure.",
        "",
        "",
        "STEP 2 - Add the extension to Chrome",
        "-" * 40,
        "",
        "1. Open Chrome and go to:  chrome://extensions",
        "",
        "2. Turn on 'Developer mode' - the switch at the top right.",
        "",
        "3. Click 'Load unpacked'.",
        "",
        '4. Choose the folder named "2 - Chrome extension" that sits',
        "   next to this file. Select the folder itself - do not open it",
        "   and pick something inside.",
        "",
        "5. Click the puzzle-piece icon in the toolbar and pin Hoza YT so",
        "   it stays visible.",
        "",
        f"The extension will always have the same ID: {extension_id}",
        "",
        "",
        "That's it",
        "-" * 40,
        "",
        "Open a video page and click the Hoza YT icon. If the panel ever",
        "says the app is not running, open Hoza YT from the Start menu -",
        "but after a normal install it should never need to be asked.",
        "",
        "",
        "Where did everything else go?",
        "-" * 40,
        "",
        "Inside the installer. The engine, the media tools and the browser",
        "connection are all part of Step 1, and none of them is a file you",
        "need to find, move or open.",
        "",
    )) + CRLF


def stage() -> int:
    if not SETUP_EXE.exists():
        say(f"Missing {SETUP_EXE.relative_to(ROOT)} - run build/build.py first.")
        return 1
    if not (EXTENSION_IN / "manifest.json").exists():
        say(f"Missing {EXTENSION_IN.relative_to(ROOT)} - run build/build.py first.")
        return 1

    manifest = json.loads((EXTENSION_IN / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]

    extension_id = "(unknown)"
    id_file = ROOT / "build" / "extension-id.txt"
    if id_file.exists():
        extension_id = id_file.read_text(encoding="utf-8").strip() or extension_id

    if RELEASE.exists():
        shutil.rmtree(RELEASE)
    APP_DIR.mkdir(parents=True)

    shutil.copy2(SETUP_EXE, APP_DIR / SETUP_EXE.name)
    say(f"   {SETUP_EXE.name} -> {APP_DIR.relative_to(DIST)}")

    # The extension folder is copied whole and kept pure: Chrome is pointed at
    # it directly, so nothing that is not part of the extension belongs inside.
    shutil.copytree(EXTENSION_IN, EXT_DIR,
                    ignore=shutil.ignore_patterns("__pycache__", "*.map"))
    files = sum(1 for item in EXT_DIR.rglob("*") if item.is_file())
    say(f"   {files} extension file(s) -> {EXT_DIR.relative_to(DIST)}")

    (RELEASE / "START HERE.txt").write_text(
        guide(version, extension_id), encoding="utf-8", newline="")
    say(f"   START HERE.txt -> {RELEASE.relative_to(DIST)}")

    say("")
    say(f"Release staged: {RELEASE.relative_to(ROOT)}  (Hoza YT {version})")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Stage the user-facing release folder")
    parser.parse_args()
    return stage()


if __name__ == "__main__":
    sys.exit(main())
