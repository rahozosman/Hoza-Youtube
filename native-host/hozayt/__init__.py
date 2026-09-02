"""Hoza YT production runtime.

One executable, three roles. Which one runs is decided by the command line,
because Chrome starts a native messaging host with arguments it chooses and
never with ours:

    HozaYT.exe chrome-extension://<id>/   ->  host        (Chrome starts this)
    HozaYT.exe --supervisor               ->  supervisor  (the host starts this)
    HozaYT.exe --backend                  ->  backend     (the supervisor starts this)
    HozaYT.exe --verify                   ->  installation check (the installer)
    HozaYT.exe --diagnose                 ->  a report for a developer

Nothing in here is a service and nothing is registered to run at logon. The
backend exists for exactly as long as a browser has a use for it.
"""

from __future__ import annotations

APP_NAME = "Hoza YT"
APP_ID = "hoza-yt"
NATIVE_HOST_NAME = "com.hoza.yt.server"

# Set by build/build.py at package time; the fallback keeps a source checkout
# runnable.
__version__ = "3.0.0"

# The extension's identity is fixed by the "key" in its manifest, so this value
# is the same whether it is loaded unpacked, from a CRX, or from the Web Store.
# The native messaging manifest names it, and the host trusts nothing else.
EXTENSION_ID = "jjmmjiadjloechcbjnjogkobifmkegeh"
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}/"

# A Web Store listing, once there is one. Empty means the installer falls back
# to the guided local-install flow instead of a registry external install.
WEBSTORE_EXTENSION_ID = ""
