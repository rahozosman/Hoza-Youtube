# Hoza YT

Hoza YT is a local-first browser extension and media dashboard for downloading
media that a web page openly makes available. It shows the formats a source
actually offers, lets you choose the quality, and keeps downloads on your
computer.

It does not bypass DRM, paywalls, login requirements, encryption, or other
access controls. Only download media that you are authorized to save.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4c8dff)
![Chrome 116+](https://img.shields.io/badge/Chrome-116%2B-4c8dff)
![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-4c8dff)
![License](https://img.shields.io/badge/data-local-34d399)

## Features

- YouTube panel with separate video and audio quality lists.
- Media detection for direct files, HTML media, HLS, and DASH manifests.
- Quality presets: Best, Recommended, Best Compatibility, and Data Saver.
- Native browser downloads for progressive media.
- HLS and DASH segment assembly.
- Download queue with pause, resume, retry, cancel, concurrency limits, and
  recovery after a browser worker restart.
- Duplicate detection, filename templates, collision handling, and history.
- Local FastAPI dashboard backed by SQLite.
- YouTube analysis through yt-dlp and optional track merging with FFmpeg.
- Loopback-only local API by default, with request validation, rate limiting,
  SSRF protection, and contained filesystem paths.
- Optional native messaging support for automatically waking the local app.

## Screenshots

### YouTube panel

| Video qualities | Audio qualities |
| --- | --- |
| ![Video quality picker](docs/youtube-video-qualities.png) | ![Audio quality picker](docs/youtube-audio-qualities.png) |

| YouTube action button | Dashboard tab |
| --- | --- |
| ![Hoza YT button beside YouTube actions](docs/youtube-panel.png) | ![Dashboard tab](docs/youtube-dashboard-tab.png) |

### Local dashboard

| Download and analyze | Available qualities |
| --- | --- |
| ![Dashboard download page](docs/dashboard-download.png) | ![Dashboard quality list](docs/dashboard-all-qualities.png) |

| Analysis details | Download history |
| --- | --- |
| ![Media analysis](docs/dashboard-analyse.png) | ![Download history](docs/dashboard-history.png) |

| Settings | Server management |
| --- | --- |
| ![Settings](docs/dashboard-settings.png) | ![Server management](docs/dashboard-servers.png) |

### Application information

![Hoza YT About page](docs/dashboard-about.png)

## Install on Windows

Download `HozaYT-Setup.exe` from the [latest GitHub
release](https://github.com/rahozosman/extentions-YT/releases), run the
installer, and follow the setup wizard.

The installer includes the local engine, Python runtime, yt-dlp, FFmpeg, and
browser native-messaging registration. Chrome does not allow a desktop
installer to silently install an unpacked extension, so the installer opens a
setup page for the final browser-extension step.

### Install the extension manually

Use this route when running from source:

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the repository folder containing `manifest.json`.

For Firefox, open `about:debugging`, select **This Firefox**, choose **Load
Temporary Add-on**, and select `manifest.json`.

## Development setup

Requirements:

- Windows 10/11 for the installer build.
- Python 3.10 or newer.
- Node.js 18 or newer for project checks.

Install the backend dependencies:

```powershell
python -m pip install -r server/requirements.txt
```

Start the local dashboard:

```powershell
npm run dev
```

Then open `http://127.0.0.1:8765/` and load the repository as an unpacked
extension in your browser. The development extension probes the local server
automatically.

Useful commands:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the local FastAPI dashboard. |
| `npm run dev:no-browser` | Start the server without opening a browser. |
| `npm run check` | Validate manifest paths, JavaScript, Python, routes, and versions. |
| `npm run verify` | Verify the native-host installation. |
| `npm run diagnose` | Produce a full local diagnostic report. |
| `npm run build:extension` | Build/stage the extension only. |
| `npm run build:installer` | Build the Windows installer. |

## Building the Windows installer

Install the backend dependencies, PyInstaller, and Inno Setup 6. Then run:

```powershell
npm run check
npm run build:installer
```

The installer is generated at:

```text
dist/HozaYT-Setup.exe
```

Other build modes:

```powershell
npm run build:installer:fast   # reuse the previous engine build
npm run build:installer:slim   # omit bundled FFmpeg
npm run build:extension        # stage only the extension
```

The version is controlled by `manifest.json`. Update it once, run
`npm run check`, and use the same version for the Git tag and GitHub release.
See [docs/production/BUILDING.md](docs/production/BUILDING.md) for packaging,
signing, third-party notices, and Web Store publishing.

## Architecture

| Directory | Responsibility |
| --- | --- |
| `src/` | Extension UI, media detection, manifest parsing, quality ranking, and browser downloads. |
| `server/` | FastAPI dashboard, yt-dlp extraction, FFmpeg integration, queue, database, and API. |
| `native-host/` | Native messaging host, supervisor, registration, and diagnostics. |
| `build/` | Validation and installer build scripts. |
| `docs/production/` | Architecture, build, and troubleshooting documentation. |

For the installed product, Chrome connects to the native host, which starts a
supervisor and a loopback FastAPI backend. Read
[ARCHITECTURE.md](docs/production/ARCHITECTURE.md) for the full data flow and
[TROUBLESHOOTING.md](docs/production/TROUBLESHOOTING.md) when something fails.

## Dashboard API

The local API is served on loopback by default.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Health, queue counts, and metrics. |
| `GET` | `/api/about` | Runtime and version information. |
| `POST` | `/api/analyze` | Analyze a media URL. |
| `POST` | `/api/jobs` | Queue a selected format. |
| `GET` | `/api/jobs` | List jobs and progress. |
| `POST` | `/api/jobs/{id}/pause` | Pause a job. |
| `POST` | `/api/jobs/{id}/resume` | Resume a job. |
| `POST` | `/api/jobs/{id}/cancel` | Cancel a job. |
| `POST` | `/api/jobs/{id}/retry` | Retry a failed job. |
| `GET` | `/api/history` | Read download history. |
| `GET` / `PUT` | `/api/settings` | Read or update local settings. |
| `GET` | `/api/diagnostics` | Run local health checks. |

## Privacy and permissions

Hoza YT stores settings, queue state, history, and media metadata locally. It
does not use analytics, cloud uploads, remote code, or third-party scripts.
The local server binds to `127.0.0.1` by default.

The extension uses browser permissions for downloads, local storage, tabs,
active-page inspection, notifications, context-menu actions, queue alarms,
offscreen segment assembly, and optional native messaging. Site access is
requested only when needed and can be revoked from the browser's extension
settings.

## GitHub: update this project

Run these commands in the folder that contains `manifest.json`.

### First upload to a new GitHub repository

Create an empty repository on GitHub, then run:

```powershell
git init
git add .
git commit -m "Prepare Hoza YT release"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPOSITORY.git
git push -u origin main
```

Replace `YOUR_USERNAME/YOUR_REPOSITORY` with your GitHub repository name.

### Push later changes

```powershell
git status
git add .
git commit -m "Describe your change"
git push
```

To update only this README:

```powershell
git add README.md
git commit -m "Improve project documentation"
git push
```

### Publish a versioned release

After updating the version in `manifest.json` and passing the checks:

```powershell
npm run check
npm run build:installer
git add .
git commit -m "Release v3.0.0"
git tag v3.0.0
git push origin main --tags
```

On GitHub, open **Releases** and choose the new tag. Attach
`dist/HozaYT-Setup.exe` as a release asset, add release notes, and publish it.

Do not commit private keys, local databases, generated installers, or secrets.
Check `.gitignore` before using `git add .`.

## License and legal boundaries

Review the repository's license and the notices generated during packaging
before redistributing builds. FFmpeg and other bundled dependencies retain
their own licenses.

Hoza YT is designed for media that the user has permission to download. It
does not handle DRM-protected, encrypted, paywalled, or authentication-gated
media, and it does not upscale or invent unavailable qualities.

## Quick Start

This section is for a first-time user.

### Windows installer

1. Open the GitHub Releases page.
2. Download `HozaYT-Setup.exe`.
3. Run the installer.
4. Follow the setup wizard.
5. Finish the browser setup page.
6. Enable the extension in the browser.
7. Open a supported media page.
8. Select a quality.
9. Click Download.
10. Open the saved file from your download folder.

The installer includes the local engine, Python, yt-dlp, and FFmpeg.
It registers the native messaging connection.
It creates shortcuts for verification and diagnostics.

### Source checkout

Use the source workflow for development and testing.

1. Install Python 3.10 or newer.
2. Install Node.js 18 or newer.
3. Open PowerShell in the project directory.
4. Install the Python dependencies.
5. Start the local server.
6. Open the local dashboard.
7. Load the extension as unpacked.
8. Test a permitted media URL.

```powershell
python -m pip install -r server/requirements.txt
npm run dev
```

Open `http://127.0.0.1:8765/` in the browser.
Keep the server window open during source testing.
Press `Ctrl+C` to stop the development server.

### Chrome or Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Select the folder containing `manifest.json`.
5. Pin Hoza YT if you want quick toolbar access.

### Firefox

1. Open `about:debugging`.
2. Select **This Firefox**.
3. Select **Load Temporary Add-on**.
4. Select the project's `manifest.json`.

Temporary Firefox extensions are removed when the browser session ends.

## How to Use Hoza YT

Use the panel when you are already watching a video.
Use the dashboard for detailed analysis and queue management.

### Download from YouTube

1. Open a YouTube video.
2. Wait for the page to load.
3. Find the Hoza YT button near the video actions.
4. Open the **Video** tab.
5. Review the available video rows.
6. Select a quality.
7. Click the download button.
8. Monitor progress in **Downloads**.

The panel can show resolution.
The panel can show frame rate.
The panel can show codec.
The panel can show container.
The panel can show HDR information.
The panel can show estimated size.

### Download audio

1. Open the Hoza YT panel.
2. Select the **Audio** tab.
3. Compare bitrate and codec.
4. Review sample rate and channels.
5. Select an audio row.
6. Click the download button.

An audio-only job does not contain video.
Choose a video row when you need a video file.

### Use the dashboard

1. Open `http://127.0.0.1:8765/`.
2. Select **Download**.
3. Paste a media URL.
4. Select **Analyze**.
5. Wait for the source details.
6. Review the available streams.
7. Choose a smart preset or individual format.
8. Confirm the selection.
9. Start the download.
10. Open **Queue** to monitor the job.

The dashboard can show title.
The dashboard can show duration.
The dashboard can show views.
The dashboard can show upload date.
The dashboard can show subtitles.
The dashboard can show chapters.
The dashboard can show HDR status.
The dashboard can show video stream counts.
The dashboard can show audio stream counts.

### Analyze direct media

1. Open a page containing openly available media.
2. Open the Hoza YT panel.
3. Grant site access if requested.
4. Wait for detection.
5. Select a detected item.
6. Select one of the formats shown.
7. Start the download.

Supported sources can include direct media files.
Supported sources can include HTML video elements.
Supported sources can include HTML audio elements.
Supported sources can include HLS playlists.
Supported sources can include DASH manifests.
Protected media is intentionally not processed.

## Understanding Quality

The largest number is not always the best format.
Check resolution, codec, container, frame rate, and size together.

### Resolution guide

| Resolution | Common description | Typical use |
| --- | --- | --- |
| `2160p` | 4K | Large screens and archival copies. |
| `1440p` | QHD | High quality with less storage than 4K. |
| `1080p` | Full HD | General viewing and sharing. |
| `720p` | HD | Smaller files with good clarity. |
| `480p` | SD | Limited bandwidth or storage. |
| `360p` | Small SD | Very limited bandwidth. |

The source may not offer every resolution.
Hoza YT does not invent missing resolutions.

### Video codecs

| Codec | Strength | Consideration |
| --- | --- | --- |
| AVC / H.264 | Works on many devices. | Can require more storage. |
| VP9 | Good quality per byte. | Hardware support varies. |
| AV1 | Efficient modern compression. | Older devices may not decode it. |

### Audio codecs

| Codec | Strength | Consideration |
| --- | --- | --- |
| AAC | Broad compatibility. | Not always the smallest option. |
| Opus | Excellent low-bitrate quality. | Older players may need conversion. |
| Vorbis | Open software support. | Less common in hardware players. |

### Containers

`MP4` is usually the safest choice for device compatibility.
`WebM` commonly contains VP9, AV1, or Opus.
`M4A` commonly contains audio-only AAC.
The best container depends on the target player or editor.

### Smart presets

| Preset | Description |
| --- | --- |
| **Best Quality** | Chooses the highest available quality. |
| **Recommended** | Balances quality, compatibility, and size. |
| **Best Compatibility** | Prefers widely supported codecs. |
| **Data Saver** | Chooses a smaller available format. |

Presets resolve to streams shown by the analysis.
They do not upscale the source.
They do not create an unavailable quality.
They do not silently replace the selected format.

## YouTube Panel Guide

### Video tab

Use Video to compare video streams.
Select a row to highlight it.
The bottom button shows the selected resolution.
The row can show a best-quality marker.
The row can show an estimated size.

### Audio tab

Use Audio to compare audio streams.
Look at bitrate and codec together.
Check the channel layout.
Check the sample rate.
Check the container.
Some rows include a dynamic-range marker.

### Dashboard tab

Dashboard opens the local application.
The current video can be passed into analysis.
Use this when the panel list is too compact.

### Downloads tab

Downloads shows current activity.
Use Queue for full controls.
Use History for completed results.

### About tab

About shows version information.
It can show extractor information.
It can show FFmpeg information.
It can show Python information.
It can show platform information.

### Missing panel button

The extension checks the YouTube action row.
It checks the area near Subscribe.
It checks the top page bar.
It can use a floating button as a fallback.
Reload YouTube after a layout change.
Reload the extension if the button remains missing.

## Dashboard Guide

### Download page

The Download page accepts a URL.
Analyze requests source metadata.
Refresh repeats an analysis.
The result card displays source information.
The preset area gives quick choices.
The format area gives detailed choices.

### Video page

The Video page filters video formats.
Compare resolution, frame rate, codec, container, and size.

### Audio page

The Audio page filters audio formats.
Compare bitrate, codec, channels, sample rate, and size.

### Queue page

Queue lists active and waiting jobs.
Each row can show title.
Each row can show media type.
Each row can show quality.
Each row can show status.
Each row can show progress.
Each row can show speed.
Each row can show estimated time.
Each row can show destination filename.

Use Pause for temporary bandwidth control.
Use Resume to continue a paused job.
Use Retry after correcting a failure.
Use Cancel to stop a job.

### History page

History records completed and failed jobs.
Use search to find a title.
Use type filters to narrow results.
Use result filters to find failures.
Use sorting to change the order.
Use Open to launch an existing file.
Use Show to reveal a file in Explorer.
Moved files can remain in history.

### Settings page

Settings are saved locally.
Settings are shared with the extension.
Choose a download folder.
Choose the default media type.
Choose the default quality.
Choose a default preset.
Enable automatic analysis when appropriate.
Choose whether to start a default job.
Configure the filename template.
Set a maximum filename length.
Choose collision behavior.
Choose emoji handling.
Set queue concurrency.
Configure duplicate handling.

### Servers page

The local server is registered automatically.
The page displays server health.
It can display additional workers.
It can configure failover behavior.
It can allow jobs on remote workers.
Use remote workers only on a network you control.
Do not expose an unprotected API to the public internet.

### Diagnostics page

Diagnostics checks the local runtime.
Run it after installation.
Run it after changing registration.
Run it when the extension cannot connect.
Keep the report with the application version.
Remove private paths before sharing it.

### Logs page

Logs separate host, supervisor, backend, and verification activity.
Start with the timestamp of the failure.
Look for startup errors.
Look for port conflicts.
Look for extractor errors.
Look for FFmpeg errors.
Look for permission errors.
Never publish session tokens.
Never publish private media URLs.

## Filename Templates

Templates help organize repeated downloads.
Common tokens include `{title}` and `{quality}`.
Other tokens include `{resolution}`, `{codec}`, and `{ext}`.

```text
{title} [{quality}].{ext}
```

The application removes invalid filename characters.
It also limits long names to the configured maximum.
Avoid putting complete URLs in filenames.

## Release Checklist

Before publishing a release, confirm the following:

- The version in `manifest.json` is correct.
- `npm run check` passes.
- The installer builds successfully.
- The extension loads in the target browser.
- The dashboard starts on loopback.
- A permitted test URL analyzes successfully.
- A test download appears in History.
- No secrets or private keys are staged.
- The Git tag matches the manifest version.

## Documentation Map

| Document | Purpose |
| --- | --- |
| `README.md` | Setup, usage, development, and publishing. |
| `docs/production/ARCHITECTURE.md` | Installed product data flow. |
| `docs/production/BUILDING.md` | Installer packaging and signing. |
| `docs/production/TROUBLESHOOTING.md` | Startup and connection problems. |

Keep downloads lawful and use Hoza YT only with media you are authorized to
save.
