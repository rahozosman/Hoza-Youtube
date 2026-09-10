"""Finding the browsers on this machine, and opening a page in one.

Used for two things only: showing the setup page after installation, and
opening the browser's own extensions page when the last step needs the user.
A browser is never modified, configured, or started with flags that change how
it behaves -- it is launched exactly as a shortcut would launch it.
"""

from __future__ import annotations

import os
import subprocess
import webbrowser
from dataclasses import dataclass
from pathlib import Path

from . import procs
from . import logbook as log


@dataclass(frozen=True)
class Browser:
    key: str
    label: str
    executable: Path
    extensions_url: str


# Registry App Paths names, in the order we would rather use them.
CANDIDATES = (
    ("chrome", "Google Chrome", "chrome.exe", "chrome://extensions"),
    ("edge", "Microsoft Edge", "msedge.exe", "edge://extensions"),
    ("brave", "Brave", "brave.exe", "brave://extensions"),
    ("vivaldi", "Vivaldi", "vivaldi.exe", "vivaldi://extensions"),
    ("opera", "Opera", "launcher.exe", "opera://extensions"),
)

APP_PATHS = r"Software\Microsoft\Windows\CurrentVersion\App Paths"

# Where these install when the registry has nothing to say.
FALLBACK_DIRS = (
    r"%ProgramFiles%\Google\Chrome\Application",
    r"%ProgramFiles(x86)%\Google\Chrome\Application",
    r"%LOCALAPPDATA%\Google\Chrome\Application",
    r"%ProgramFiles(x86)%\Microsoft\Edge\Application",
    r"%ProgramFiles%\Microsoft\Edge\Application",
    r"%ProgramFiles%\BraveSoftware\Brave-Browser\Application",
    r"%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application",
    r"%ProgramFiles%\Vivaldi\Application",
    r"%LOCALAPPDATA%\Vivaldi\Application",
)


def _from_registry(executable: str) -> Path | None:
    try:
        import winreg
    except ImportError:
        return None
    for root in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        try:
            with winreg.OpenKey(root, f"{APP_PATHS}\\{executable}") as key:
                value, _ = winreg.QueryValueEx(key, "")
        except OSError:
            continue
        candidate = Path(os.path.expandvars(str(value).strip('"')))
        if candidate.is_file():
            return candidate
    return None


def _from_disk(executable: str) -> Path | None:
    for directory in FALLBACK_DIRS:
        candidate = Path(os.path.expandvars(directory)) / executable
        if candidate.is_file():
            return candidate
    return None


def installed() -> list[Browser]:
    """Every supported browser that is actually on this machine."""
    found = []
    for key, label, executable, url in CANDIDATES:
        path = _from_registry(executable) or _from_disk(executable)
        if path is not None:
            found.append(Browser(key, label, path, url))
    return found


def preferred() -> Browser | None:
    """The browser to guide the user through, Chrome first."""
    browsers = installed()
    return browsers[0] if browsers else None


def open_setup_page(url: str) -> bool:
    """Show the setup page, in a supported browser where there is one.

    The default browser might be one the extension cannot run in, and sending
    someone to a setup page in a browser that will never host the extension is
    worse than sending them nowhere.
    """
    browser = preferred()
    if browser is not None:
        started = procs.spawn_detached([str(browser.executable), url])
        if started is not None:
            log.info(f"Opened the setup page in {browser.label}.")
            return True
    try:
        return bool(webbrowser.open(url))
    except Exception:
        log.error("No browser could be opened for the setup page.")
        return False


def open_extensions_page(browser: Browser | None = None) -> bool:
    """Open the browser's own extensions page.

    A web page is not allowed to navigate anywhere with a `chrome://` scheme,
    which is exactly the protection it sounds like. A desktop program starting
    the browser with that address is the supported way to get someone there.
    """
    browser = browser or preferred()
    if browser is None:
        return False
    started = procs.spawn_detached([str(browser.executable), browser.extensions_url])
    return started is not None


def reveal(path: Path) -> bool:
    """Open a folder in Explorer with nothing selected inside it."""
    try:
        subprocess.Popen(["explorer", str(path)], close_fds=True)
        return True
    except OSError:
        return False
