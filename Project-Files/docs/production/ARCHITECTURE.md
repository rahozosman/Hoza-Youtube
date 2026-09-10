# Production architecture

How the installed product is put together, and why each piece is where it is.

For building it, see [BUILDING.md](BUILDING.md). For diagnosing it, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

---

## The shape of it

```
  Chrome / Edge / Brave / Vivaldi
        │
        │  extension  (jjmmjiadjloechcbjnjogkobifmkegeh)
        │
        │  chrome.runtime.connectNative('com.hoza.yt.server')
        ▼
  HozaYT.exe  (host role)          ← Chrome starts this, hidden
        │
        │  starts, detached
        ▼
  HozaYT.exe  (supervisor role)    ← owns the backend's lifetime
        │
        │  starts, watched
        ▼
  HozaYT.exe  (backend role)       ← FastAPI + yt-dlp + ffmpeg
        │
        └── http://127.0.0.1:<port>   ← the extension and the dashboard
```

One executable, three roles. Chrome decides the command line when it starts a
native messaging host — it passes the calling extension's origin and a parent
window handle, and accepts nothing of ours — so the product cannot ship three
programs and tell Chrome which to run. It ships one that reads its own
arguments:

| Command | Role |
| --- | --- |
| `HozaYT.exe` | Open the dashboard (the Start menu shortcut) |
| `HozaYT.exe chrome-extension://…/` | Native messaging host (**Chrome only**) |
| `HozaYT.exe --supervisor` | Backend manager |
| `HozaYT.exe --backend` | The backend itself |
| `HozaYT.exe --verify` | Check the installation |
| `HozaYT.exe --register` / `--unregister` | Browser registration |
| `HozaYT.exe --setup` | Open the browser-setup page |
| `HozaYT.exe --stop` | Stop the engine |
| `HozaYT.exe --diagnose` | Full report for a developer |

The executable is built with a **console subsystem**, which is required:
native messaging is stdio, and a windowed build has no valid standard handles
to read Chrome's pipe from. No window is ever seen, because Chrome launches
native hosts hidden and every internal relaunch passes `CREATE_NO_WINDOW`.

---

## The one thing an installer cannot do

**Chrome will not let a desktop program install this extension silently, and
the product does not try to make it.**

The rule, from Chrome's own documentation on alternative installation methods:

> As of Chrome 33, no external installs are allowed from a path to a local CRX
> file on Windows.

The Windows registry route (`HKCU\Software\Google\Chrome\Extensions\<id>`)
accepts exactly one value for `update_url`, the Chrome Web Store's:
`https://clients2.google.com/service/update2/crx`. Force-installing a
self-hosted extension through `ExtensionInstallForcelist` additionally requires
the browser to be enrolled in Chrome Browser Cloud Management, which is a
property of a managed fleet and not something an installer may arrange for
itself on someone's personal machine.

So the installer automates everything on this side of that line, and the
remaining step is made as small as Chrome allows:

| Step | Who does it |
| --- | --- |
| Install the engine, runtime and media tools | Installer |
| Register the native messaging host with every browser | Installer |
| Start the engine and verify it end to end | Installer |
| Open a setup page that watches for the extension | Installer |
| Add the extension | **The person, once** |

There are two routes for that last step, chosen at build time:

**Web Store route** — set `WEBSTORE_EXTENSION_ID` in
`native-host/hozayt/__init__.py`. The installer writes the registry
declaration, Chrome installs the extension from the Web Store on its next
start, and the user's only action is the enable prompt Chrome shows them. This
is the supported consumer distribution model and the one to use once there is
a listing.

**Local route** (what ships today) — the installer lays the production
extension down at `…\Programs\HozaYT\extension` and opens a page that opens
the browser's Extensions page for them, offers the folder path on the
clipboard, and reveals it in Explorer. Three clicks, and the page finishes
itself the moment the extension says hello.

---

## Identity

The extension carries a `key` in `manifest.json`. This is not decoration: it is
what makes the extension's id the same wherever it is loaded from, and without
it the whole architecture is impossible — a native messaging manifest names the
extension it will talk to, and an id that changes with the folder cannot be
named by an installer that ran first.

```
manifest.json "key"  ──sha256──▶  jjmmjiadjloechcbjnjogkobifmkegeh
                                          │
                                          ▼
                    com.hoza.yt.server.json "allowed_origins"
```

`build/check.py` verifies the two still agree. The matching private key
(`build/private/extension-key.pem`, never committed) is needed only to sign a
CRX; the public half in the manifest is what fixes the id.

---

## Starting and stopping

Nothing is registered to run at logon. There is no service, no scheduled task
and no `Run` key — an installation that has just finished is running no
background process at all.

The engine's life is bounded by the browser's:

```
  browser opens
      → extension's service worker loads
      → connectNative
      → host starts the supervisor
      → supervisor picks a port, starts the backend
      → "ready", with the port and the session token
```

and

```
  last browser window closes
      → supervisor waits 30s (in case it is only a restart)
      → asks the backend whether anything is still downloading
      → stops it, or waits until the downloads finish
```

The states the supervisor records are the states the extension shows:

```
  starting → ready
  ready → crashed → restarting → ready
```

Restarts are bounded: five failures inside ten minutes and the supervisor stops
trying and records why. A backend that cannot start is a fault to report, not a
loop to run forever.

After a Windows restart, nothing runs until a browser opens. Opening one starts
the whole chain again in a couple of seconds.

---

## Ports

The extension does not know the port and must not guess. The supervisor picks
one:

1. the port that worked last time, then 8765;
2. if it is free, take it;
3. if it is busy, ask what is there — a Hoza YT backend that will talk to us is
   **adopted**, not replaced;
4. otherwise try 8766–8799, then let the OS choose.

**A port that is taken belongs to whoever took it.** Nothing in the product
terminates a process to free an address. (An earlier development supervisor
did; that behaviour is not in the shipped code.)

The chosen port reaches the extension over native messaging and reaches the
dashboard through the address it was opened at. Neither has a number written
into it.

---

## Security

**Least privilege at the boundary.** The native messaging host is the only
thing an extension can reach, so it is the smallest component in the product.
It honours two actions, `start` and `status`, and they carry no parameters at
all — no field of an incoming message is ever used as a path, a port, a command
or an argument. It cannot stop anything, delete anything, read a file, or run
anything the installation did not ship. It also checks the origin Chrome passes
against the id it was built for, so a host manifest edited to open it up still
gets a host that will not talk to a stranger.

**Two independent locks on the API.**

1. *Origin.* CORS admits `chrome-extension://`, `moz-extension://` and
   loopback only. A cross-origin request carrying `Content-Type:
   application/json` is preflighted, and the preflight is refused for anything
   else.
2. *Session token.* The supervisor generates one per session and hands it to
   exactly two callers: the extension, over a channel Chrome opens only for the
   one extension named in the host manifest; and the dashboard, injected into
   the page the backend itself serves, which no other origin can read. Every
   `/api/` route requires it.

`/api/health` is the single exception, because the supervisor and the installer
have to ask whether the backend is alive before anyone could have handed them a
secret. Unauthenticated, it answers identity and liveness only — the queue, the
metrics and the extension's state are added once the caller proves entitlement.

Development is unaffected: `python server/server.py` sets no token, requires
none, and behaves exactly as it always did.

**Per-user, everywhere.** Program files under `%LOCALAPPDATA%\Programs`,
data under `%LOCALAPPDATA%\HozaYT`, registration under `HKEY_CURRENT_USER`.
No machine-wide key, no policy, no elevation — the installer never shows a UAC
prompt.

---

## Where things live

| Path | What | Survives an upgrade |
| --- | --- | --- |
| `%LOCALAPPDATA%\Programs\HozaYT\` | Engine, runtime, ffmpeg, extension | replaced |
| `…\HozaYT\com.hoza.yt.server.json` | Native host manifest | replaced |
| `…\HozaYT\licenses\`, `THIRD-PARTY-NOTICES.txt` | Notices | replaced |
| `%LOCALAPPDATA%\HozaYT\data\` | Database, settings, temp | **kept** |
| `%LOCALAPPDATA%\HozaYT\logs\` | host, supervisor, backend, verify | kept |
| `%LOCALAPPDATA%\HozaYT\runtime.json` | Port, pid, session token | per session |
| `%LOCALAPPDATA%\HozaYT\supervisor.lock` | Single-instance lock | per session |
| `HKCU\Software\…\NativeMessagingHosts\com.hoza.yt.server` | Registration | rewritten |
| `HKCU\Software\HozaYT` | Version, install path, extension id | rewritten |

Uninstalling removes the first group and the registry entries, and asks before
touching the second. Downloaded files are never touched.

---

## Development versus production

Both are supported and neither has been bent to accommodate the other.

| | Development | Production |
| --- | --- | --- |
| Backend | `python server/server.py` | `HozaYT.exe --backend` |
| Started by | you | the supervisor, on demand |
| Port | 8765, fixed | chosen, reported |
| Token | none | per session |
| Extension | loaded unpacked from the repository | installed from `…\HozaYT\extension` |
| ffmpeg | whatever is on `PATH`, or `imageio-ffmpeg` | the bundled build |

The extension needs no build to work in development, and finds a development
server by itself: if no native host is registered, it probes
`127.0.0.1:8765` and uses it untokenized. So a contributor with a checkout and
an unpacked extension gets exactly the workflow the project always had.
