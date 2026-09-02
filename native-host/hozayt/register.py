"""Registering the native messaging host with the browsers on this machine.

This is the one piece of the product that a browser extension is not allowed to
do for itself, and the reason a desktop installer exists at all. Chrome finds a
native host by reading a per-user registry value that names a JSON manifest;
the manifest names the executable and, crucially, the single extension that is
allowed to talk to it.

Everything written here is per-user (HKEY_CURRENT_USER) and confined to the
`NativeMessagingHosts` key each browser publishes for exactly this purpose. No
policy is written, no machine-wide key is touched, and nothing needs
administrator rights.
"""

from __future__ import annotations

import json
from pathlib import Path

from . import (
    APP_NAME, EXTENSION_ID, EXTENSION_ORIGIN, NATIVE_HOST_NAME,
    WEBSTORE_EXTENSION_ID, places,
)
from . import logbook as log

# The Firefox add-on id, from `browser_specific_settings` in the manifest.
FIREFOX_EXTENSION_ID = "hoza-yt@hozadownload.local"

# Every Chromium browser publishes the same key under its own vendor path.
# Writing to a browser that is not installed simply creates a key nobody reads,
# so the list is generous rather than clever.
CHROMIUM_KEYS = (
    r"Software\Google\Chrome\NativeMessagingHosts",
    r"Software\Chromium\NativeMessagingHosts",
    r"Software\Microsoft\Edge\NativeMessagingHosts",
    r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    r"Software\Vivaldi\NativeMessagingHosts",
    r"Software\Opera Software\NativeMessagingHosts",
    r"Software\Yandex\YandexBrowser\NativeMessagingHosts",
)

GECKO_KEYS = (r"Software\Mozilla\NativeMessagingHosts",)

# Where an external install would be declared, if there is a Web Store listing
# to point at. Chrome accepts no other source here: since Chrome 33 a local CRX
# path is refused on Windows, which is why this is the only automatic route to
# installing the extension itself.
CHROMIUM_EXTENSION_KEYS = (
    r"Software\Google\Chrome\Extensions",
    r"Software\Microsoft\Edge\Extensions",
)
WEBSTORE_UPDATE_URL = "https://clients2.google.com/service/update2/crx"


def host_executable() -> Path:
    return places.program_dir() / "HozaYT.exe"


def manifest_path(flavour: str = "chromium") -> Path:
    name = NATIVE_HOST_NAME if flavour == "chromium" else f"{NATIVE_HOST_NAME}.firefox"
    return places.program_dir() / f"{name}.json"


def _manifest(flavour: str) -> dict:
    common = {
        "name": NATIVE_HOST_NAME,
        "description": f"{APP_NAME} local engine",
        "path": str(host_executable()),
        "type": "stdio",
    }
    if flavour == "chromium":
        common["allowed_origins"] = [EXTENSION_ORIGIN]
    else:
        common["allowed_extensions"] = [FIREFOX_EXTENSION_ID]
    return common


def write_manifests() -> list[Path]:
    """Write the host manifests beside the executable. Returns what was written."""
    written = []
    for flavour in ("chromium", "gecko"):
        target = manifest_path(flavour)
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps(_manifest(flavour), indent=2), encoding="utf-8")
            written.append(target)
        except OSError as err:
            log.error(f"Could not write {target}: {err}")
    return written


def _winreg():
    try:
        import winreg
    except ImportError:
        return None
    return winreg


def register() -> bool:
    """Point every browser on this machine at our host manifest."""
    winreg = _winreg()
    if winreg is None:
        log.error("This platform has no registry; nothing to register.")
        return False

    write_manifests()
    chromium = str(manifest_path("chromium"))
    gecko = str(manifest_path("gecko"))

    registered = 0
    for root, value in (
        *[(key, chromium) for key in CHROMIUM_KEYS],
        *[(key, gecko) for key in GECKO_KEYS],
    ):
        path = f"{root}\\{NATIVE_HOST_NAME}"
        try:
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, path, 0,
                                    winreg.KEY_WRITE) as key:
                winreg.SetValueEx(key, "", 0, winreg.REG_SZ, value)
            registered += 1
        except OSError as err:
            log.warn(f"Could not register under {root}: {err}")

    log.info(f"Registered the native host with {registered} browser key(s).")
    return registered > 0


def unregister() -> None:
    """Undo `register`. Only our own key is removed, never the parent."""
    winreg = _winreg()
    if winreg is None:
        return
    for root in (*CHROMIUM_KEYS, *GECKO_KEYS):
        path = f"{root}\\{NATIVE_HOST_NAME}"
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER, path)
            log.info(f"Removed {path}")
        except OSError:
            # Not there, which is the desired end state anyway.
            pass
    for flavour in ("chromium", "gecko"):
        try:
            manifest_path(flavour).unlink(missing_ok=True)
        except OSError:
            pass
    unregister_webstore()


def registered_for() -> list[str]:
    """The browser keys that currently point at our manifest."""
    winreg = _winreg()
    if winreg is None:
        return []
    found = []
    expected = {str(manifest_path("chromium")).lower(),
                str(manifest_path("gecko")).lower()}
    for root in (*CHROMIUM_KEYS, *GECKO_KEYS):
        path = f"{root}\\{NATIVE_HOST_NAME}"
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, path) as key:
                value, _ = winreg.QueryValueEx(key, "")
        except OSError:
            continue
        if str(value).lower() in expected:
            found.append(root)
    return found


# --------------------------------------------------------------------------- #
# The extension itself
#
# Chrome will install an extension named here automatically, but only from the
# Web Store: `update_url` accepts nothing else, and a local CRX path has been
# refused on Windows since Chrome 33. With a listing, this is the whole
# installation. Without one, the installer falls back to the guided flow and
# this does nothing.
# --------------------------------------------------------------------------- #

def register_webstore() -> bool:
    if not WEBSTORE_EXTENSION_ID:
        return False
    winreg = _winreg()
    if winreg is None:
        return False
    done = 0
    for root in CHROMIUM_EXTENSION_KEYS:
        path = f"{root}\\{WEBSTORE_EXTENSION_ID}"
        try:
            with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, path, 0,
                                    winreg.KEY_WRITE) as key:
                winreg.SetValueEx(key, "update_url", 0, winreg.REG_SZ,
                                  WEBSTORE_UPDATE_URL)
            done += 1
        except OSError as err:
            log.warn(f"Could not declare the extension under {root}: {err}")
    if done:
        log.info("Declared the extension for automatic installation from the "
                 "Web Store. The browser asks the user to enable it on next start.")
    return done > 0


def unregister_webstore() -> None:
    if not WEBSTORE_EXTENSION_ID:
        return
    winreg = _winreg()
    if winreg is None:
        return
    for root in CHROMIUM_EXTENSION_KEYS:
        try:
            winreg.DeleteKey(winreg.HKEY_CURRENT_USER,
                             f"{root}\\{WEBSTORE_EXTENSION_ID}")
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Traces of the development-era setup
#
# Before this installer existed, running the server by hand registered a
# scheduled task and a Run value that started it at sign-in. A machine that has
# been through that must not keep two things competing to own the backend, so
# an install clears them out. Only what that setup created is touched.
# --------------------------------------------------------------------------- #

LEGACY_TASKS = ("Hoza YT Autorun", "Hoza YT Watchdog")
LEGACY_RUN_VALUES = ("Hoza YT Autorun",)
LEGACY_RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
LEGACY_STARTUP_LINKS = (
    "Hoza YT Watchdog.lnk", "Hoza YT Server.lnk", "Hoza YT Autorun.lnk",
)


def clear_legacy_autostart() -> list[str]:
    """Remove the development autostart entries. Returns what went."""
    import os
    import subprocess

    removed = []
    creation = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    for task in LEGACY_TASKS:
        try:
            probe = subprocess.run(["schtasks", "/Query", "/TN", task],
                                   capture_output=True, text=True,
                                   creationflags=creation)
            if probe.returncode == 0:
                subprocess.run(["schtasks", "/Delete", "/TN", task, "/F"],
                               capture_output=True, text=True,
                               creationflags=creation)
                removed.append(f"scheduled task {task!r}")
        except OSError:
            pass

    winreg = _winreg()
    if winreg is not None:
        for value in LEGACY_RUN_VALUES:
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, LEGACY_RUN_KEY, 0,
                                    winreg.KEY_SET_VALUE) as key:
                    winreg.DeleteValue(key, value)
                removed.append(f"sign-in entry {value!r}")
            except OSError:
                pass

    startup = Path(os.environ.get("APPDATA", "")) / \
        "Microsoft/Windows/Start Menu/Programs/Startup"
    for name in LEGACY_STARTUP_LINKS:
        link = startup / name
        try:
            if link.exists():
                link.unlink()
                removed.append(f"startup shortcut {name!r}")
        except OSError:
            pass

    for item in removed:
        log.info(f"Removed the {item} left by the development setup.")
    return removed
