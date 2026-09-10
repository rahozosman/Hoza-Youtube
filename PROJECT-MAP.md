# What is what in this project

Everything here falls into one of three groups. Two of them a user touches.
The third one they never should.

| | What | Where | Who touches it |
|---|---|---|---|
| **1** | The app | `dist/release/1 - Install the app/HozaYT-Setup.exe` | The user runs it once |
| **2** | The Chrome extension | `dist/release/2 - Chrome extension/` | The user loads it into Chrome once |
| **3** | Everything else | the rest of this repository | Only you |

The user-facing pair is staged by `python build/release.py`, which a full
`python build/build.py` runs at the end. Hand someone `dist/release/` and
nothing else — it contains those two items and a `START HERE.txt`, and no
third thing to wonder about.

---

## 1. The app — `HozaYT-Setup.exe`

One double-click, and then nothing. The installer registers the native
messaging host for the installed browsers, starts the engine, and verifies
that the two can actually talk before it reports success. After that the app
starts itself whenever the extension needs it.

There is no server to start by hand, no port to choose, no terminal, and no
setting to fill in. If a user is ever told to launch something manually, that
is a bug in the install, not a step that was forgotten.

Uninstalling reverses exactly this much: the engine is stopped and the browser
registration removed. Downloads, history and settings are left alone.

## 2. The Chrome extension

The only manual step in the product, because Chrome has no other way to accept
an extension that is not on the Web Store. The user opens `chrome://extensions`,
turns on Developer mode, clicks **Load unpacked**, and selects the
`2 - Chrome extension` folder.

That folder is kept **pure** — `manifest.json`, `icons/`, `src/`, and nothing
else. Notes, readmes and stray files do not go in it, because Chrome is pointed
at the folder itself and anything extra is shipped to every user.

`manifest.json` carries a fixed `key`, so the extension ID is always
`jjmmjiadjloechcbjnjogkobifmkegeh`. That is what lets the installer register a
native host for it in advance — change the key and every existing install stops
finding the app.

## 3. Everything the user never touches

| Folder | What it is |
|---|---|
| `src/` | Extension source. `dist/release/2 - Chrome extension/` is built from it — edit here, never there. |
| `server/` | The local backend: analysis, the queue, the dashboard, the API the extension calls. |
| `native-host/` | The `hozayt` package the frozen exe runs — native messaging host, supervisor, port negotiation, browser registration. |
| `build/` | `build.py` builds everything; `release.py` stages the two user-facing items. `build/work/` is scratch. |
| `installer/` | The Inno Setup script that becomes `HozaYT-Setup.exe`. |
| `icons/` | Source icons for both the extension and the exe. |
| `docs/`, `.github/` | Documentation and CI. |
| `dist/HozaYT/`, `dist/extension/` | Build intermediates. The installer swallows both. Not for handing out. |

`dist/HozaYT/HozaYT.exe` is the engine, not the product. It is the same binary
the installer places, and running it from `dist/` skips the registration that
makes the extension able to start it — so it is a debugging tool, not a
shortcut around step 1.

---

## Working without the installer

For development, the two halves can be run separately:

```
python server/server.py            # backend on 127.0.0.1:8765
```

Then load `dist/extension/` (or the repo root after a build) as an unpacked
extension. With no registered native host the extension falls back to
`127.0.0.1:8765`, which is where that server listens.

The catch: only a registered native host learns the real port. If something
else already holds 8765 the app picks another one and an unpacked extension
cannot find it. To get the full behaviour without the installer:

```
dist\HozaYT\HozaYT.exe --register
```

Other roles: `--verify` checks an installation, `--diagnose` prints a full
report, `--stop` stops the engine, `--unregister` removes the browser
registration.
