"""
 Lumen Media Server
--------------------
 A small local HTTP server that detects supported video links, lists the real
 qualities they offer, and downloads the chosen one into a folder you pick.
 Video and audio tracks are merged with a bundled ffmpeg.

Run:   python server.py            (or double-click start-server.bat)
Open:  http://127.0.0.1:8765
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import yt_dlp
except ImportError:  # pragma: no cover
    print("yt-dlp is missing. Run:  python -m pip install -r requirements.txt")
    sys.exit(1)

HERE = Path(__file__).resolve().parent
HOST = "127.0.0.1"
PORT = int(os.environ.get("LUMEN_PORT", "8765"))
SETTINGS_FILE = HERE / "settings.json"
INDEX_FILE = HERE / "index.html"

DEFAULT_DOWNLOAD_DIR = Path.home() / "Downloads" / "YouTube"

YOUTUBE_HOSTS = {
    "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
    "youtu.be", "www.youtu.be", "youtube-nocookie.com", "www.youtube-nocookie.com",
}

ZOOM_HOSTS = {"zoom.us"}


# --------------------------------------------------------------------------- #
# ffmpeg
# --------------------------------------------------------------------------- #

def find_ffmpeg():
    """Prefer an ffmpeg on PATH, otherwise the one bundled with imageio-ffmpeg."""
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


FFMPEG = find_ffmpeg()


# --------------------------------------------------------------------------- #
# Settings
# --------------------------------------------------------------------------- #

_settings_lock = threading.Lock()


def load_settings():
    data = {}
    if SETTINGS_FILE.exists():
        try:
            data = json.loads(SETTINGS_FILE.read_text("utf-8"))
        except Exception:
            data = {}
    data.setdefault("download_dir", str(DEFAULT_DOWNLOAD_DIR))
    data.setdefault("filename_template", "%(title)s [%(height)sp].%(ext)s")
    return data


def save_settings(data):
    with _settings_lock:
        SETTINGS_FILE.write_text(json.dumps(data, indent=2), "utf-8")


def get_download_dir():
    p = Path(load_settings()["download_dir"]).expanduser()
    p.mkdir(parents=True, exist_ok=True)
    return p


# --------------------------------------------------------------------------- #
# URL detection
# --------------------------------------------------------------------------- #

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def detect_youtube(url):
    """Return (is_youtube, video_id, kind). kind: 'video' | 'playlist' | None."""
    url = (url or "").strip()
    if not url:
        return False, None, None
    if VIDEO_ID_RE.match(url):
        return True, url, "video"
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    try:
        parsed = urlparse(url)
    except Exception:
        return False, None, None
    host = (parsed.hostname or "").lower()
    if host not in YOUTUBE_HOSTS:
        return False, None, None

    qs = parse_qs(parsed.query)
    path = parsed.path or "/"

    if host.endswith("youtu.be"):
        vid = path.strip("/").split("/")[0]
        return True, vid or None, "video" if vid else None

    if path.startswith("/watch"):
        vid = (qs.get("v") or [None])[0]
        return True, vid, "video" if vid else None
    m = re.match(r"^/(shorts|embed|live|v)/([A-Za-z0-9_-]{11})", path)
    if m:
        return True, m.group(2), "video"
    if path.startswith("/playlist"):
        return True, (qs.get("list") or [None])[0], "playlist"
    return True, None, None


def detect_zoom(url):
    """Return (is_zoom, url, kind) for shareable Zoom recording links."""
    url = (url or "").strip()
    if not url:
        return False, None, None
    if not re.match(r"^https?://", url, re.I):
        url = "https://" + url
    try:
        parsed = urlparse(url)
    except Exception:
        return False, None, None
    host = (parsed.hostname or "").lower().rstrip(".")
    path = parsed.path or "/"
    is_zoom_host = host in ZOOM_HOSTS or host.endswith(".zoom.us")
    if not is_zoom_host:
        return False, None, None
    if path.startswith("/rec/"):
        return True, url, "recording"
    if path.startswith("/clips/"):
        return True, url, "clip"
    return True, None, None


def detect_source(url):
    """Return (source, identifier, kind) for a supported source."""
    youtube, identifier, kind = detect_youtube(url)
    if youtube:
        return "youtube", identifier, kind
    zoom, identifier, kind = detect_zoom(url)
    if zoom:
        return "zoom", identifier, kind
    return None, None, None


def normalise_url(url):
    ok, vid, kind = detect_youtube(url)
    if ok and vid and kind == "video":
        return f"https://www.youtube.com/watch?v={vid}"
    return url.strip()


# --------------------------------------------------------------------------- #
# Format listing
# --------------------------------------------------------------------------- #

def human_size(n):
    if not n:
        return None
    units = ["B", "KB", "MB", "GB"]
    i = 0
    n = float(n)
    while n >= 1024 and i < len(units) - 1:
        n /= 1024
        i += 1
    return f"{n:.1f} {units[i]}" if i else f"{int(n)} {units[i]}"


def estimate_size(f, duration):
    """Rough size from bitrate when YouTube does not report one."""
    tbr = f.get("tbr")
    if tbr and duration:
        return int(tbr * 1000 / 8 * duration)
    return None


def build_qualities(info):
    """
    Turn yt-dlp's raw format list into a short menu of choices.

    With ffmpeg we can merge the best video-only stream with the best audio,
    so every resolution is offered. Without ffmpeg only progressive files
    (video + audio in one) are safe, so only those are listed.
    """
    formats = info.get("formats") or []
    duration = info.get("duration") or 0
    best_by_height = {}

    for f in formats:
        if f.get("vcodec") in (None, "none"):
            continue
        height = f.get("height")
        if not height:
            continue
        has_audio = f.get("acodec") not in (None, "none")
        if not FFMPEG and not has_audio:
            continue
        vcodec = (f.get("vcodec") or "").lower()
        ext = f.get("ext")
        proto = (f.get("protocol") or "").lower()
        # Prefer direct https files (they report size and resume cleanly) over HLS,
        # then avc1/mp4 for compatibility, then framerate, then bitrate.
        score = (
            1 if proto.startswith("http") else 0,
            2 if vcodec.startswith("avc1") else 1 if vcodec.startswith("vp") else 0,
            1 if ext == "mp4" else 0,
            f.get("fps") or 0,
            f.get("tbr") or 0,
        )
        cur = best_by_height.get(height)
        if cur is None or score > cur["_score"]:
            best_by_height[height] = {
                "_score": score,
                "format_id": f.get("format_id"),
                "height": height,
                "width": f.get("width"),
                "fps": f.get("fps"),
                "vcodec": vcodec,
                "ext": ext,
                "has_audio": has_audio,
                "filesize": f.get("filesize") or f.get("filesize_approx") or estimate_size(f, duration),
                "tbr": f.get("tbr"),
            }

    best_audio = None
    for f in formats:
        if f.get("vcodec") not in (None, "none"):
            continue
        if f.get("acodec") in (None, "none"):
            continue
        abr = f.get("abr") or f.get("tbr") or 0
        if best_audio is None or abr > best_audio["abr"]:
            best_audio = {
                "format_id": f.get("format_id"),
                "abr": abr,
                "ext": f.get("ext"),
                "acodec": f.get("acodec"),
                "filesize": f.get("filesize") or f.get("filesize_approx") or estimate_size(f, duration),
            }

    qualities = []
    for height in sorted(best_by_height, reverse=True):
        q = best_by_height[height]
        size = q["filesize"]
        if FFMPEG and not q["has_audio"] and best_audio and size and best_audio.get("filesize"):
            size = size + best_audio["filesize"]
        label = f"{height}p"
        if q["fps"] and q["fps"] > 30:
            label += f"{int(q['fps'])}"
        if height >= 2160:
            label += " (4K)"
        elif height >= 1440:
            label += " (2K)"
        elif height >= 1080:
            label += " (Full HD)"
        elif height >= 720:
            label += " (HD)"
        if FFMPEG:
            fmt = f"{q['format_id']}+bestaudio[ext=m4a]/{q['format_id']}+bestaudio/{q['format_id']}"
        else:
            fmt = q["format_id"]
        qualities.append({
            "id": f"v{height}",
            "kind": "video",
            "label": label,
            "detail": f"{q['width']}x{q['height']} - {q['vcodec'].split('.')[0]} - mp4",
            "size": human_size(size),
            "format": fmt,
            "height": height,
        })

    if best_audio:
        qualities.append({
            "id": "audio-m4a",
            "kind": "audio",
            "label": "Audio only",
            "detail": f"{int(best_audio['abr'])} kbps - {best_audio['ext']}",
            "size": human_size(best_audio["filesize"]),
            "format": "bestaudio[ext=m4a]/bestaudio",
            "height": 0,
        })
        if FFMPEG:
            qualities.append({
                "id": "audio-mp3",
                "kind": "audio",
                "label": "MP3",
                "detail": f"converted from {int(best_audio['abr'])} kbps source",
                "size": human_size(best_audio["filesize"]),
                "format": "bestaudio/best",
                "height": 0,
                "mp3": True,
            })
    return qualities


def probe(url):
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") == "playlist":
        entries = info.get("entries") or []
        info = entries[0] if entries else info
    return {
        "id": info.get("id"),
        "title": info.get("title"),
        "uploader": info.get("uploader") or info.get("channel"),
        "duration": info.get("duration"),
        "duration_string": info.get("duration_string"),
        "thumbnail": info.get("thumbnail"),
        "view_count": info.get("view_count"),
        "webpage_url": info.get("webpage_url") or url,
        "is_live": bool(info.get("is_live")),
        "ffmpeg": bool(FFMPEG),
        "qualities": build_qualities(info),
    }


# --------------------------------------------------------------------------- #
# Download jobs
# --------------------------------------------------------------------------- #

class Job:
    def __init__(self, url, quality):
        self.id = uuid.uuid4().hex[:10]
        self.url = url
        self.quality = quality
        self.status = "queued"        # queued | downloading | merging | done | error | cancelled
        self.progress = 0.0
        self.downloaded = 0
        self.total = 0
        self.speed = None
        self.eta = None
        self.title = None
        self.filename = None
        self.filepath = None
        self.error = None
        self.created = time.time()
        self.cancel_flag = False
        self.thread = None

    def to_dict(self):
        return {
            "id": self.id,
            "url": self.url,
            "quality": self.quality.get("label"),
            "status": self.status,
            "progress": round(self.progress, 1),
            "downloaded": human_size(self.downloaded),
            "total": human_size(self.total),
            "speed": (human_size(self.speed) + "/s") if self.speed else None,
            "eta": self.eta,
            "title": self.title,
            "filename": self.filename,
            "filepath": self.filepath,
            "error": self.error,
            "created": self.created,
        }


class Cancelled(Exception):
    pass


JOBS = {}
JOBS_LOCK = threading.Lock()


def run_job(job: Job):
    job.status = "downloading"
    out_dir = get_download_dir()
    template = load_settings().get("filename_template") or "%(title)s [%(height)sp].%(ext)s"
    if job.quality.get("kind") == "audio":
        template = "%(title)s.%(ext)s"

    def hook(d):
        if job.cancel_flag:
            raise Cancelled()
        st = d.get("status")
        if st == "downloading":
            job.status = "downloading"
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            job.total = total
            job.downloaded = done
            job.speed = d.get("speed")
            job.eta = d.get("eta")
            if total:
                job.progress = min(99.0, done * 100.0 / total)
        elif st == "finished":
            job.downloaded = job.total or d.get("downloaded_bytes") or job.downloaded
            job.filepath = d.get("filename")
            job.progress = max(job.progress, 99.0)

    def pp_hook(d):
        if job.cancel_flag:
            raise Cancelled()
        if d.get("status") == "started":
            job.status = "merging"
        elif d.get("status") == "finished":
            info = d.get("info_dict") or {}
            fp = info.get("filepath") or info.get("_filename")
            if fp:
                job.filepath = fp

    opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "format": job.quality["format"],
        "outtmpl": str(out_dir / template),
        "windowsfilenames": True,
        "progress_hooks": [hook],
        "postprocessor_hooks": [pp_hook],
        "retries": 5,
        "fragment_retries": 5,
        "concurrent_fragment_downloads": 4,
        "overwrites": False,
    }
    if FFMPEG:
        opts["ffmpeg_location"] = FFMPEG
        if job.quality.get("mp3"):
            opts["postprocessors"] = [{
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }]
        elif job.quality.get("kind") == "video":
            opts["merge_output_format"] = "mp4"

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(job.url, download=True)
            job.title = info.get("title")
            # Resolve the final filename after every postprocessor has run.
            rd = info.get("requested_downloads") or []
            if rd and rd[0].get("filepath"):
                job.filepath = rd[0]["filepath"]
            elif not job.filepath:
                job.filepath = ydl.prepare_filename(info)
        if job.cancel_flag:
            raise Cancelled()
        job.filename = os.path.basename(job.filepath) if job.filepath else None
        job.progress = 100.0
        job.status = "done"
    except Cancelled:
        job.status = "cancelled"
        job.error = "Cancelled"
        _cleanup_partials(out_dir)
    except Exception as e:  # noqa: BLE001
        job.status = "error"
        msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e))
        job.error = msg.replace("ERROR: ", "").strip()[:400]


def _cleanup_partials(out_dir: Path):
    try:
        for p in out_dir.glob("*.part"):
            if time.time() - p.stat().st_mtime < 3600:
                p.unlink(missing_ok=True)
        for p in out_dir.glob("*.ytdl"):
            p.unlink(missing_ok=True)
    except Exception:
        pass


def start_job(url, quality):
    job = Job(url, quality)
    with JOBS_LOCK:
        JOBS[job.id] = job
    t = threading.Thread(target=run_job, args=(job,), daemon=True)
    job.thread = t
    t.start()
    return job


# --------------------------------------------------------------------------- #
# OS helpers
# --------------------------------------------------------------------------- #

def open_folder(path):
    path = str(path)
    if sys.platform.startswith("win"):
        os.startfile(path)  # noqa: S606
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


def reveal_file(path):
    if sys.platform.startswith("win") and os.path.exists(path):
        subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])
    else:
        open_folder(os.path.dirname(path))


def pick_folder_dialog(initial):
    """Open the OS folder picker in a helper process so tkinter stays off the server thread."""
    code = (
        "import sys,tkinter as tk;from tkinter import filedialog;"
        "r=tk.Tk();r.withdraw();r.attributes('-topmost',True);"
        "p=filedialog.askdirectory(initialdir=sys.argv[1],title='Choose download folder');"
        "print(p or '')"
    )
    try:
        out = subprocess.run([sys.executable, "-c", code, initial],
                             capture_output=True, text=True, timeout=300)
        return out.stdout.strip() or None
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #

class Handler(BaseHTTPRequestHandler):
    server_version = "LumenYouTube/1.0"

    def log_message(self, fmt, *args):  # quieter console
        if os.environ.get("LUMEN_DEBUG"):
            super().log_message(fmt, *args)

    # -- helpers -----------------------------------------------------------
    def _send_json(self, obj, code=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    # -- GET ---------------------------------------------------------------
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            body = INDEX_FILE.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if path in ("/api/status", "/health"):
            self._send_json({
                "ok": True,
                "ffmpeg": bool(FFMPEG),
                "ffmpeg_path": FFMPEG,
                "yt_dlp": yt_dlp.version.__version__,
                "download_dir": str(get_download_dir()),
            })
            return
        if path == "/ready":
            ready = bool(FFMPEG and get_download_dir())
            self._send_json({"ok": ready, "ffmpeg": bool(FFMPEG)}, 200 if ready else 503)
            return
        if path == "/api/settings":
            s = load_settings()
            s["download_dir_exists"] = Path(s["download_dir"]).expanduser().is_dir()
            self._send_json(s)
            return
        if path == "/api/jobs":
            with JOBS_LOCK:
                jobs = sorted(JOBS.values(), key=lambda j: j.created, reverse=True)
            self._send_json({"jobs": [j.to_dict() for j in jobs]})
            return
        self._send_json({"error": "Not found"}, 404)

    # -- POST --------------------------------------------------------------
    def do_POST(self):
        path = urlparse(self.path).path
        data = self._read_json()

        if path == "/api/detect":
            source, identifier, kind = detect_source(data.get("url", ""))
            self._send_json({
                "supported": bool(source and identifier),
                "source": source,
                "youtube": source == "youtube",
                "zoom": source == "zoom",
                "id": identifier,
                "kind": kind,
            })
            return

        if path == "/api/info":
            url = data.get("url", "")
            source, identifier, kind = detect_source(url)
            if not source:
                self._send_json({"error": "That link is not a supported YouTube or Zoom video."}, 400)
                return
            if source == "youtube" and kind == "playlist":
                self._send_json({"error": "Playlists are not supported yet. Paste a single video link."}, 400)
                return
            if not identifier:
                self._send_json({"error": "Could not identify a supported video in that link."}, 400)
                return
            try:
                info = probe(normalise_url(url))
            except Exception as e:  # noqa: BLE001
                msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e)).replace("ERROR: ", "")
                self._send_json({"error": msg[:400]}, 502)
                return
            if info.get("is_live"):
                self._send_json({"error": "Live streams cannot be downloaded."}, 400)
                return
            self._send_json(info)
            return

        if path == "/api/download":
            raw_url = data.get("url", "")
            source, identifier, kind = detect_source(raw_url)
            if not source or not identifier or (source == "youtube" and kind != "video"):
                self._send_json({"error": "Downloads are limited to single YouTube or Zoom videos."}, 400)
                return
            url = normalise_url(raw_url)
            quality = data.get("quality") or {}
            if not url or not quality.get("format"):
                self._send_json({"error": "Missing url or quality."}, 400)
                return
            job = start_job(url, quality)
            self._send_json(job.to_dict())
            return

        if path == "/api/cancel":
            jid = data.get("id")
            with JOBS_LOCK:
                job = JOBS.get(jid)
            if not job:
                self._send_json({"error": "No such job."}, 404)
                return
            job.cancel_flag = True
            if job.status == "queued":
                job.status = "cancelled"
            self._send_json({"ok": True})
            return

        if path == "/api/remove":
            jid = data.get("id")
            with JOBS_LOCK:
                job = JOBS.get(jid)
                if job and job.status in ("done", "error", "cancelled"):
                    JOBS.pop(jid, None)
            self._send_json({"ok": True})
            return

        if path == "/api/clear":
            with JOBS_LOCK:
                for k in [k for k, j in JOBS.items() if j.status in ("done", "error", "cancelled")]:
                    JOBS.pop(k, None)
            self._send_json({"ok": True})
            return

        if path == "/api/settings":
            s = load_settings()
            new_dir = (data.get("download_dir") or "").strip()
            if new_dir:
                p = Path(new_dir).expanduser()
                try:
                    p.mkdir(parents=True, exist_ok=True)
                    probe_file = p / ".lumen-write-test"
                    probe_file.write_text("ok")
                    probe_file.unlink()
                except Exception as e:  # noqa: BLE001
                    self._send_json({"error": f"Cannot use that folder: {e}"}, 400)
                    return
                s["download_dir"] = str(p)
            if (data.get("filename_template") or "").strip():
                s["filename_template"] = data["filename_template"].strip()
            save_settings(s)
            s["download_dir_exists"] = True
            self._send_json(s)
            return

        if path == "/api/open-folder":
            try:
                open_folder(get_download_dir())
                self._send_json({"ok": True})
            except Exception as e:  # noqa: BLE001
                self._send_json({"error": str(e)}, 500)
            return

        if path == "/api/reveal":
            jid = data.get("id")
            with JOBS_LOCK:
                job = JOBS.get(jid)
            if job and job.filepath:
                try:
                    reveal_file(job.filepath)
                    self._send_json({"ok": True})
                    return
                except Exception as e:  # noqa: BLE001
                    self._send_json({"error": str(e)}, 500)
                    return
            self._send_json({"error": "File not found."}, 404)
            return

        if path == "/api/pick-folder":
            chosen = pick_folder_dialog(str(get_download_dir()))
            self._send_json({"download_dir": chosen})
            return

        self._send_json({"error": "Not found"}, 404)


def main():
    get_download_dir()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    url = f"http://{HOST}:{PORT}"
    print("=" * 60)
    print("  Lumen YouTube Server")
    print(f"  Open:       {url}")
    print(f"  Downloads:  {get_download_dir()}")
    print(f"  ffmpeg:     {FFMPEG or 'NOT FOUND (only progressive qualities offered)'}")
    print(f"  yt-dlp:     {yt_dlp.version.__version__}")
    print("  Press Ctrl+C to stop.")
    print("=" * 60)
    if "--no-browser" not in sys.argv:
        try:
            import webbrowser
            threading.Timer(0.8, lambda: webbrowser.open(url)).start()
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
