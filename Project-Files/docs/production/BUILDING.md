# Building the installer

One command produces `dist/HozaYT-Setup.exe`. This page is the whole of what a
developer needs to know about producing it.

---

## Once, per machine

| Need | Get it |
| --- | --- |
| Windows 10/11, 64-bit | the installer targets it and has to be built on it |
| Python 3.10+ | <https://www.python.org/downloads/> |
| Node 18+ | only for the pre-build checks |
| The backend's dependencies | `python -m pip install -r server/requirements.txt` |
| PyInstaller | `python -m pip install pyinstaller` |
| Inno Setup 6 | `winget install JRSoftware.InnoSetup` |

`build/build.py` finds Inno Setup in the usual places, per-user and
per-machine, versions 6 and 7. If it is somewhere unusual, put `ISCC.exe` on
`PATH`.

---

## Build it

```powershell
npm run build:installer
```

or, identically:

```powershell
python build/build.py
```

Roughly two to four minutes from cold. The output:

```
dist/
  HozaYT-Setup.exe      the installer                          ~110 MB
  HozaYT/               the engine, as the installer lays it down
    HozaYT.exe          one executable, every role
    _internal/          the Python runtime, ffmpeg, the dashboard
    extension/          the production extension
    licenses/           licence files copied from the packages themselves
    THIRD-PARTY-NOTICES.txt
  extension/            the same extension, unpacked, for the Web Store
```

### Options

| Command | What it does |
| --- | --- |
| `npm run build:installer` | everything |
| `npm run build:installer:fast` | reuse the last engine build — seconds, for iterating on the installer |
| `npm run build:installer:slim` | leave ffmpeg out — ~25 MB instead of ~110 MB |
| `npm run build:extension` | stage the extension only |
| `npm run check` | the pre-build checks, no build |

`--no-ffmpeg` produces a working product that reports itself as *degraded* and
offers no conversion it cannot perform. Useful for testing the installer, not
for shipping.

---

## Versions

`manifest.json` holds **the** version. `build/build.py` stamps it into
`native-host/hozayt/__init__.py` and `server/app/__init__.py`, into the
executable's Windows version resource, and into the installer. There is one
number to change for a release, and `npm run check` fails if they have drifted.

```powershell
# release 3.1.0
#   1. edit manifest.json  ->  "version": "3.1.0"
#   2. npm run check
#   3. npm run build:installer
#   4. git tag v3.1.0
```

---

## Before building

```powershell
npm run check
```

Six checks, each of which has broken this project at least once: every path the
manifest names exists; the extension's id matches the one the native host is
registered for; every JavaScript file parses; every Python module compiles; the
backend's routes are all still there; the versions that must agree, agree.

---

## The extension's identity

`manifest.json` contains a `key`. It fixes the extension's id at
`jjmmjiadjloechcbjnjogkobifmkegeh` wherever it is loaded from, which is what
lets an installer that runs *before* the extension exists register a native
messaging host for it.

**Never change or remove it.** Doing so gives the extension a new id, and every
installation in the field loses its connection to the engine.

The matching private key lives at `build/private/extension-key.pem` and is
git-ignored. It is needed only to sign a `.crx`; the build does not use it, and
a fresh checkout without it still produces an extension with the same id. Keep
it somewhere safe anyway — it is the only thing that can sign an update for a
self-hosted CRX.

---

## Publishing to the Chrome Web Store

Worth doing: it turns the user's last step into a single click and lets the
installer declare the extension so Chrome fetches it by itself.

1. Upload `dist/extension/` (zipped) to the Web Store dashboard.
   Keep the `key` field — the store accepts it and it preserves the id.
2. Take the id the store assigns.
3. Put it in `native-host/hozayt/__init__.py`:

   ```python
   WEBSTORE_EXTENSION_ID = "the-id-the-store-gave-you"
   ```

4. Rebuild.

The installer now writes `HKCU\Software\Google\Chrome\Extensions\<id>` with the
Web Store's `update_url`, Chrome installs the extension on its next start, and
the setup page shows the one-click route instead of the folder route. Nothing
else changes.

---

## Signing

Unsigned, Windows SmartScreen will warn on first download. To sign, add to
`installer/HozaYT.iss`:

```
SignTool=signtool
SignedUninstaller=yes
```

and register the tool with Inno Setup (Tools ▸ Configure Sign Tools):

```
signtool=$p sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /a $f
```

`build/hozayt.spec` accepts a `codesign_identity` for the executable itself if
you want that signed separately.

---

## What is inside, and under what licence

`build/build.py` writes `THIRD-PARTY-NOTICES.txt` from the packages actually
present, and copies their licence files out of the installed distributions —
what ships is what the authors published, not a transcription.

FFmpeg needs a decision rather than a default. The bundled build comes from
`imageio-ffmpeg` and is a **GPL** build. It is redistributed as a separate,
unmodified executable that the backend starts as its own process; it is not
linked into anything, so its licence stays its own. The notices name the build
and where its source is.

If you would rather ship an LGPL build, point `imageio-ffmpeg` at one (its
`IMAGEIO_FFMPEG_EXE` mechanism) before building, or drop one into the spec's
`binaries` list. The backend prefers whatever the installation ships over
anything on the machine's `PATH`, so the choice is genuinely yours to make.

---

## Testing a build without installing it

Every role runs from a checkout, entering exactly the same code:

```powershell
python native-host/run.py --verify        # the installation checks
python native-host/run.py --diagnose      # everything, for a bug report
python native-host/run.py --supervisor    # the backend manager, in the console
python native-host/run.py --backend       # the backend alone
```

And the installed build, from `%LOCALAPPDATA%\Programs\HozaYT`:

```powershell
.\HozaYT.exe --verify
.\HozaYT.exe --diagnose
```

---

## Continuous integration

`.github/workflows/ci.yml` checks the backend and the extension on Linux, which
covers everything except the packaging. Building the installer needs a Windows
runner:

```yaml
  installer:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: python -m pip install -r server/requirements.txt pyinstaller
      - run: winget install JRSoftware.InnoSetup --accept-package-agreements --silent
      - run: python build/check.py
      - run: python build/build.py
      - uses: actions/upload-artifact@v4
        with: { name: HozaYT-Setup, path: dist/HozaYT-Setup.exe }
```
