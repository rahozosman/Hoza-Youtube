<h1 align="center">Hoza YT</h1>

<p align="center">
  A browser extension and a local app that download video and audio from the web —
  at the quality the source actually offers, and nothing it does not.
</p>

<p align="center">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-4c8dff">
  <img alt="Chrome 116+" src="https://img.shields.io/badge/Chrome-116%2B-4c8dff">
  <img alt="Python 3.10+" src="https://img.shields.io/badge/Python-3.10%2B-4c8dff">
  <img alt="No build step" src="https://img.shields.io/badge/build-none-34d399">
  <img alt="Local only" src="https://img.shields.io/badge/data-stays%20local-34d399">
</p>

---

## Demo

<video src="docs/demo.mp4" poster="docs/preview.png" controls muted playsinline width="100%"></video>

[![Hoza YT in action](docs/preview.png)](docs/demo.mp4)

**▶ [Watch the demo (47s)](docs/demo.mp4)** — the button on a YouTube page, the
quality panel, and the dashboard behind it.

> GitHub does not always play a repository-hosted `.mp4` inline. If the player
> above is not interactive, the image is a link to the file. To get a real
> inline player, drag `docs/demo.mp4` into a GitHub issue, copy the
> `user-images.githubusercontent.com` URL it produces, and paste that here.
>
> The recording predates the rename, so the interface in it still says
> "HOZA Download".

---

## The two halves

Hoza YT is two programs that work together, and either works alone.

| | What it is | What it handles |
|---|---|---|
| **The extension** (`src/`) | A Manifest V3 extension. No build step, no dependencies, no bundler. | Media a page exposes openly: `<video>`, `<audio>`, direct links, HLS and DASH manifests. |
| **The local app** (`server/`) | A small FastAPI service with its own dashboard at `127.0.0.1:8765`. | YouTube, which signs and throttles its stream URLs — so it needs `yt-dlp` and `ffmpeg`, which an extension cannot carry. |

They meet on the YouTube page itself: the extension puts a button in the
action row, and the panel behind it talks to the local app.

---

## On YouTube

The extension adds a **Hoza YT** button in the same row as Like, Share and
Save. Pressing it opens a panel anchored underneath with five sections:

| Section | What it shows |
|---|---|
| **Video** | Every video quality the link offers — resolution, frame rate, codec, container, HDR, size. Pick one, download it. |
| **Audio** | Every audio track — bitrate, codec, channels, sample rate, size. Tracks with compressed dynamic range are labelled `DRC`. |
| **Dashboard** | Opens the full dashboard, with this video already loaded. |
| **About** | Developer, contact, and the exact versions of the app, extension, yt-dlp, FFmpeg and Python. |
| **Downloads** | The live queue: progress, speed and time remaining, updating while you watch. |

The button is never absent. It takes the best place available and verifies it
actually landed there:

1. the **action row**, beside Like and Share;
2. beside **Subscribe**, for older layouts;
3. the **top bar**, on pages with no video — home, search, channels;
4. a **floating pill**, if the page offers nothing to sit beside.

Scroll down into the comments and a pill fades in at the corner, so the panel
stays one click away. Open the home page and the button sits in the top bar;
click into a video and it moves down into the action row by itself.

---

## Install

### 1. The local app

Needed for YouTube. Python 3.10 or newer.

```bash
# Windows: double-click server/install-service.bat — it installs what it
# needs, starts the server now, and keeps it running from then on.

# Any platform:
pip install -r server/requirements.txt
python server/server.py
```

It serves `http://127.0.0.1:8765`, binding to loopback by default (`--host`
changes that). `yt-dlp` and a bundled `ffmpeg` (via `imageio-ffmpeg`) come in
as dependencies — nothing has to be on your `PATH`.

#### Never starting it by hand (Windows)

A browser extension cannot launch a program on your machine, so the server has
to already be running when you click the toolbar button. `install-service.bat`
is the one thing you run, once:

| Script | What it does |
| --- | --- |
| `server/install-service.bat` | **Run once.** Installs dependencies, registers the sign-in task, starts the watchdog now. |
| `server/status.bat` | Is the server up? Is the watchdog up? Where is the log? |
| `server/stop-server.bat` | Stops the watchdog, then the server. In that order, or it just comes back. |
| `server/uninstall-service.bat` | Removes the task and stops everything for good. |
| `server/start-server.bat` | Starts the server by hand, in a window you can watch. |
| `server/update-yt-dlp.bat` | Run when downloads start failing. YouTube changes often. |

**The watchdog** (`server/watchdog.py`) is what makes it stay up. It asks
`/api/health` every 15 seconds and restarts the server on either kind of
failure:

- the process **died** — seen through the child's exit code
- the process **hung** — seen through three silent health checks in a row,
  which a plain restart-on-exit loop never catches

Failed starts back off (5s → 15s → 30s → 1m → 2m → 5m) so a broken install
cannot spin the CPU, a lock file keeps two watchdogs from fighting over the
port, and an already-running server is adopted rather than duplicated. It logs
to `server/data/watchdog.log`, rotated at 1 MB.

**And something watches the watchdog.** The scheduled task carries two
triggers: one at sign-in, and one that repeats every ten minutes forever. The
repeating one costs nothing while the watchdog is alive — `MultipleInstances`
is `IgnoreNew`, so the task simply declines to start a second copy — and it is
what brings the watchdog back if the process is ever killed. The launcher waits
on the watchdog rather than firing and forgetting, which is what keeps the task
in the `Running` state and makes that suppression work.

The task runs as you, at sign-in, with no time limit. **No administrator
rights** — and if policy blocks task registration, the installer falls back to
a Startup-folder shortcut on its own. Nothing shows a console window:
`pythonw.exe` runs the watchdog, and the watchdog spawns the server with
`CREATE_NO_WINDOW`.

Recovery times, worst case:

| What died | Back up within |
| --- | --- |
| the server crashed or hung | ~45 seconds |
| the watchdog itself was killed | ~10 minutes |
| the machine was restarted | sign-in, plus 20 seconds |

### 2. The extension

**Chrome / Edge**

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**.
3. **Load unpacked**, and select this folder.

**Firefox** — the code runs against a compatibility layer, and Firefox's event
page has DOM access, so segment assembly happens inline there rather than in an
offscreen document. Load it through `about:debugging` → **This Firefox** →
**Load Temporary Add-on**, selecting `manifest.json`.

The extension asks for **no site access at all** on first run. You grant each
site from the panel, and can revoke it at any time from the browser's
extensions page. The one exception is `127.0.0.1:8765`, declared in the
manifest so the panel can reach the local app.

---

## What it deliberately does not do

These are limits by design, not gaps waiting to be filled.

**It does not circumvent protection.** When a page negotiates Encrypted Media
Extensions, an HLS playlist carries `#EXT-X-KEY`, or a DASH manifest carries
`<ContentProtection>`, it reports that the media is protected and stops. There
is no key handling and no DRM path. Media behind a paywall or a login is not a
target.

**It does not invent quality.** The list shows what the source serves. There is
no "320 kbps MP3" generated from a 128 kbps Opus source.

**It does not download live streams.** A stream with no declared end has no
well-defined file to produce.

**The extension alone does not merge separate video and audio tracks.** Muxing
needs an encoder. Where a source separates them, the options are labelled
*Video only* and *Audio only*. The local app does merge them, because it has
ffmpeg.

---

## Architecture

```
manifest.json                 MV3 manifest — no host permissions but the local app
docs/                         Demo recording and poster frame

src/                          The extension
  core/                       Pure logic, no browser APIs
    constants.js              Message types, enums, thresholds
    errors.js                 Error taxonomy: codes -> what the user reads
    hls-parser.js             HLS master and media playlists
    dash-parser.js            MPD parsing and segment plans
    xml.js                    Dependency-free XML reader (workers lack DOMParser)
    quality-resolver.js       Ranking, badges, smart presets
    filename.js               Template rendering and cross-platform sanitising
    dedupe.js                 URL normalising and duplicate detection
    assembler.js              Ordered segment fetch and join
    settings.js  storage.js  browser-compat.js  format-utils.js

  background/                 Service worker and collaborators
    service-worker.js         Message router and lifecycle
    local-server.js           Bridge to the local app, so the page never calls it
    media-registry.js         Per-tab detected media, in memory only
    net-observer.js           Read-only webRequest media sniffing
    manifest-probe.js         Fetch, parse and resolve streams
    download-manager.js       Native downloads and segment assembly
    queue-manager.js          Jobs, concurrency, persistence, recovery
    history.js  notifications.js  context-menu.js  offscreen-bridge.js

  content/
    panel.js                  The YouTube button and its in-page panel
    detector.js               DOM scan (isolated world, no imports by necessity)
    page-probe.js             EME observation (MAIN world, read-only)

  offscreen/                  Blob assembly host — workers cannot make blob URLs
  ui/                         popup, download manager, settings

server/                       The local app
  server.py                   Launcher
  app/
    main.py                   HTTP API and static hosting
    analyzer.py               yt-dlp extraction, normalised into streams
    formats.py                Presets, audio tiers, format selection
    jobs.py                   Queue, progress, pause/resume/retry
    downloader.py             The download itself, with disk guards
    ffmpeg.py                 Probe and merge
    db.py  config.py  security.py  servers.py  diagnostics.py  logs.py
  static/                     The dashboard
```

**Data flow, extension.** `detector` and `net-observer` feed `media-registry`.
`manifest-probe` turns a registry item into ranked streams. The UI renders
those, and a choice becomes a job in `queue-manager`.

**Data flow, YouTube.** `panel.js` asks the service worker, the service worker
asks the local app, the local app runs `yt-dlp` and merges with `ffmpeg`. The
page itself never calls the API — the server accepts only extension and
loopback origins, so a content script's request would be refused anyway.

### Two design notes

**Why an offscreen document.** Chromium service workers have no
`URL.createObjectURL`. Joined segments have to become a blob URL somewhere, so
assembly happens in an offscreen document and the worker hands the resulting
URL to `chrome.downloads`. Firefox event pages have DOM access, so the same
assembler runs inline — the branch is a feature probe, not a UA check.

**Why segment joining works without an encoder.** MPEG-TS segments concatenate
into a playable `.ts`. Fragmented MP4 segments concatenate behind their
initialisation segment into a playable `.mp4`. Both are byte-exact joins — and
that is precisely why merging *separate* video and audio tracks is a different
problem: that is muxing, not concatenation.

---

## The dashboard

`http://127.0.0.1:8765` — Dashboard, Download, Video, Audio, Queue, History,
Servers, Settings, Diagnostics, Logs and About.

Paste a link and it is analysed on paste. Pick a preset (**Best**,
**Recommended**, **Best Compatibility**, **Data Saver**) or a specific format,
and it downloads with live progress, pause, resume, retry and cancel.
Downloads default to `~/Downloads/Hoza YT`.

### API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Status, queue counts, ffmpeg availability, metrics |
| `GET` | `/api/about` | App, developer, contact, versions |
| `POST` | `/api/analyze` | Every quality a link offers, plus presets and audio tiers |
| `POST` | `/api/jobs` | Queue a download from a verified format selection |
| `GET` | `/api/jobs` | The queue, with progress and stats |
| `POST` | `/api/jobs/{id}/{pause\|resume\|cancel\|retry}` | Control one job |
| `GET` | `/api/events` | Server-sent events: job created, progress, finished |
| `GET` | `/api/history` | Completed and failed records |
| `GET` `PUT` | `/api/settings` | Read and update configuration |
| `GET` | `/api/diagnostics` | Self-checks: ffmpeg, extractor, disk, network |
| `GET` | `/api/logs` | Recent log records, filterable |

Every request body is validated at the boundary by Pydantic. Requests are rate
limited (120/minute by default) and capped in size, URLs are checked against
SSRF into the local network, and every path the app writes is contained inside
a directory you approved.

---

## Permissions

| Permission | Why |
|---|---|
| `downloads` | Save files and report progress |
| `storage`, `unlimitedStorage` | Settings and history, locally |
| `activeTab` | Scan the current page when you open the panel |
| `scripting` | Run that scan |
| `webRequest` *(optional)* | Observe media responses on granted sites, read-only |
| `offscreen` | Join segments into one file |
| `notifications` | Report completion and failure |
| `contextMenus` | Right-click entries |
| `tabs` | Title and address of the tab a download came from |
| `alarms` | Queue upkeep |
| `http://127.0.0.1:8765/*` | Reach the local app |

`webRequest` is *optional* rather than required, and is requested from the
panel the first time you grant a site. Declaring it up front with no host
permissions makes Chrome warn at load time that it can never fire — asking at
the moment it becomes useful is quieter and more honest.

## Privacy

Everything stays on the device. Settings and history go to local extension
storage and a local SQLite file; detected media lives in memory for the open
tab and is dropped when that tab navigates away. No analytics, no telemetry,
no third-party scripts, no remote code. Page contents are never uploaded, and
the local app listens on loopback unless you tell it otherwise.

`server/data/` — the database, your resolved configuration and the temporary
directory — is git-ignored, because it is this machine's download history.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+D` | Open the panel |
| `Alt+Shift+Q` | One-click download at your preferred quality |
| `Alt+Shift+M` | Open the download manager |

## Filename templates

Extension default: `{title} - {quality}` → `How Lenses Bend Light - 1080p.mp4`

Tokens: `{title}` `{quality}` `{resolution}` `{codec}` `{audiocodec}`
`{container}` `{fps}` `{duration}` `{domain}` `{date}` `{time}` `{index}`

Reserved Windows device names, illegal characters, control characters, trailing
dots and path traversal are all handled. Collisions become `Video (1).mp4`.
The local app uses yt-dlp tokens instead: `%(title)s`, `%(height)s`,
`%(uploader)s`, `%(id)s`.

---

## Continuous integration

Three workflows run in GitHub Actions.

| Workflow | When | What it does |
| --- | --- | --- |
| `ci.yml` | every push and pull request | Installs the server on Python 3.10 and 3.12, byte-compiles it, imports the app and asserts the expected routes exist, then boots the server and calls `/api/health`. Separately checks that every file `manifest.json` points at actually exists, and that every module under `src/` parses. |
| `release.yml` | a `v*` tag | Refuses to build if the tag and `manifest.json` disagree, packs `manifest.json`, `src/` and `icons/` into `hoza-yt-<tag>.zip`, and attaches it to a GitHub release. |
| `yt-dlp-watch.yml` | Mondays, 06:00 UTC | Compares the pin in `server/requirements.txt` against PyPI and keeps one rolling issue open when it has fallen behind. YouTube breaks downloads regularly and a stale `yt-dlp` is nearly always why. |

### What Actions cannot do

It cannot host the server. Jobs are capped at six hours, the runner is
destroyed when the job ends, nothing can reach it from outside without a
tunnel, and GitHub's Actions policy limits the service to work on the
repository itself — a long-lived server or tunnel is grounds for suspension.

It would not help anyway. Downloads would land on GitHub's disk rather than
yours, the extension talks to `127.0.0.1:8765`, and YouTube blocks datacenter
addresses hard enough that `yt-dlp` fails on a runner almost immediately.

The server is meant to be local. The watchdog is what makes it always-on.

### Release checks

`/api/updates` asks GitHub whether a newer release exists, at most once a day:

```bash
curl http://127.0.0.1:8765/api/updates
```

Nothing needs configuring. The repository is read from `git remote get-url
origin`, overridden by `HOZA_GITHUB_REPO` if it is set, and the check reports
itself `disabled` when there is no remote. A private repository or one with no
releases reports `unavailable`, which is a state and not an error.

---

## Troubleshooting

**The button is not on YouTube.** Reload the extension at `chrome://extensions`,
then hard-refresh the tab (`Ctrl+Shift+R`). It logs one line on mount —
`[Hoza YT] Download button mounted (actions)` — which tells you where it went.

**"The Hoza YT app is not running."** Run `server/install-service.bat` once so
it comes up with Windows and stays up. `server/status.bat` says what is running,
and `server/data/watchdog.log` says what happened.

**Downloads suddenly fail on YouTube.** YouTube changes often. Run
`server/update-yt-dlp.bat`, or `pip install -U yt-dlp`.

**A second instance on the same machine** needs its own state:
`python server/server.py --data-dir <path>`.

---

## Developer

**Rahoz Osman** — <hozahoza2001@gmail.com>

Shown under **About** in both the panel and the dashboard. The manifest carries
`"author": { "email": ... }`, the only authorship key Chrome recognises — a
`developer` key makes Chrome log *Unrecognized manifest key*, so the name lives
in the About section instead.

## Responsible use

Hoza YT is for media you are authorised to download. Respect the terms of the
sites you visit and the rights of the people who made what you are saving. The
protection boundaries above are not configurable.
