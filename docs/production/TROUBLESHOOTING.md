# Troubleshooting

Start here:

**Start menu ▸ Hoza YT ▸ Check the installation.**

It runs the same six checks the installer ran, in plain words, and names what
is wrong. Almost everything below is a longer explanation of one of its
answers.

---

## For anyone

### The extension says "Hoza YT is not installed on this computer"

The extension cannot find the local engine at all. Either it was never
installed, or it was installed for a different Windows account — everything is
per-user, so an installation done while signed in as someone else does not
apply to you. Install it while signed in as yourself.

### The extension says "Starting…" and stays there

The engine is being launched and has not answered yet. A cold start takes a
couple of seconds; the extension waits up to 90.

If it never gets past this, run **Check the installation**. The usual cause is
security software holding the engine at launch — see
[Antivirus](#antivirus-and-smartscreen).

### The extension says "Reconnecting…"

The engine restarted underneath it — usually because it was updated, or because
it crashed and was brought back. It reconnects by itself. If it does not settle
within a minute, restart your browser.

### The extension says "Hoza YT is unavailable"

The engine could not be started five times in ten minutes, so it stopped
trying rather than looping. Restart the computer, then open your browser. If it
comes back, run **Check the installation** and, failing that, reinstall — an
upgrade keeps your settings and history.

### The Hoza YT button is missing from YouTube

That is the extension, not the engine. Reload the extension from your browser's
Extensions page, then reload YouTube with `Ctrl+Shift+R`.

### I finished the installer but nothing happened in my browser

The last step is the one Chrome will not let an installer do for you: adding
the extension. **Start menu ▸ Hoza YT ▸ Finish browser setup** reopens the page
that walks you through it, and it finishes by itself once the extension
connects.

### Downloads stop when I close my browser

They should not, and they are designed not to: the engine checks for downloads
in progress before it shuts down, and stays open until they finish. If a
download really was lost, the Logs page in the dashboard will say why.

### Antivirus and SmartScreen

The installer is not code-signed yet, so Windows SmartScreen shows *"Windows
protected your PC"* on first run. **More info ▸ Run anyway** if you trust where
you got it from.

Some security products are also suspicious of any program a browser launches,
which is exactly what a native messaging host is. If the engine will not start,
allow `%LOCALAPPDATA%\Programs\HozaYT\HozaYT.exe`.

---

## For developers

### Where things are

```
%LOCALAPPDATA%\Programs\HozaYT\      program files
%LOCALAPPDATA%\HozaYT\logs\          host.log, supervisor.log, backend.log, verify.log
%LOCALAPPDATA%\HozaYT\runtime.json   port, pid, session token, state
%LOCALAPPDATA%\HozaYT\data\          database, settings, temp
```

### The one command worth running

```powershell
& "$env:LOCALAPPDATA\Programs\HozaYT\HozaYT.exe" --diagnose
```

Paths, runtime state (with the token redacted), which browsers are registered,
and every check with its result. It is what to attach to a bug report.

### Reading the logs

Four files, one per role, so a crashed backend does not bury the host's account
of what it was doing.

| File | Written by | Says |
| --- | --- | --- |
| `host.log` | the native messaging host | Chrome connected, what it asked for, whether the engine came up |
| `supervisor.log` | the backend manager | port chosen, starts, health, restarts, why it stopped |
| `backend.log` | the backend itself | uvicorn and application output |
| `verify.log` | `--verify` / `--register` | every installation check, and registration |

The host never writes to stdout: Chrome reads that as a message frame and drops
the connection when it is not one. If `host.log` is empty, Chrome never started
the host — a registration problem, not a host problem.

### Chrome is not starting the native host

Check the chain, in this order:

```powershell
# 1. Does the browser know where the manifest is?
Get-ItemProperty "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.hoza.yt.server"

# 2. Does the manifest exist, and name the right extension and the right exe?
Get-Content "$env:LOCALAPPDATA\Programs\HozaYT\com.hoza.yt.server.json"

# 3. Is the extension's id the one the manifest allows?
#    chrome://extensions with Developer mode on shows it.
```

The id must be `jjmmjiadjloechcbjnjogkobifmkegeh`. If it is not, the extension
was loaded from a copy whose `manifest.json` has lost its `key` — that field is
what fixes the id, and without it the id follows the folder.

`HozaYT.exe --register` rewrites all of it.

Chrome only reads these keys at startup. After registering, restart Chrome
fully — closing the last window is not always enough; check Task Manager.

### The engine is on a port I did not expect

By design. The supervisor takes 8765 when it is free, and moves on when it is
not — it never terminates whatever is already there. `runtime.json` has the
real number, and the extension is told it over native messaging.

```powershell
Get-Content "$env:LOCALAPPDATA\HozaYT\runtime.json"
```

To find out what took 8765:

```powershell
Get-NetTCPConnection -LocalPort 8765 -State Listen |
  ForEach-Object { Get-Process -Id $_.OwningProcess }
```

A frequent answer on a developer's machine is *your own development server* —
in which case the supervisor adopts it rather than starting a second one, which
is what makes an unpacked extension work against a checkout.

### Everything returns 401

The session token is missing or stale. It is generated per engine session, so a
dashboard tab left open across an engine restart holds an old one — reload the
page. The extension re-negotiates by itself, once, on any 401.

A development server (`python server/server.py`) sets no token and requires
none, so a 401 there means something else entirely.

### A leftover development autorun

Before this installer existed, running the server by hand registered a
scheduled task that started it at sign-in. Two systems competing to own the
backend never agree, so `--register` removes it. If a stale copy is still
*running* from before the removal, it holds its port until it is stopped:

```powershell
python server/autorun.py --stop     # from a checkout
```

### Rebuilding after changing the backend

The backend is inside the packaged executable. Editing `server/app/*.py` does
not change an installed engine until you rebuild:

```powershell
npm run build:installer:fast   # if only the extension or installer changed
npm run build:installer        # if any Python changed
```

For an edit-run-edit loop, skip packaging entirely and use the development
server — the extension finds it on its own.

### Uninstalling by hand

If the uninstaller is gone:

```powershell
& "$env:LOCALAPPDATA\Programs\HozaYT\HozaYT.exe" --stop
& "$env:LOCALAPPDATA\Programs\HozaYT\HozaYT.exe" --unregister
Remove-Item "$env:LOCALAPPDATA\Programs\HozaYT" -Recurse -Force
Remove-Item "HKCU:\Software\HozaYT" -Recurse -Force
# and, only if you want your settings and history gone too:
# Remove-Item "$env:LOCALAPPDATA\HozaYT" -Recurse -Force
```

### Reporting a problem

Attach the output of `--diagnose` and the relevant log. Between them they carry
the version, the state, the port, the registration and the last thing each role
did. The token is redacted; nothing else is.
