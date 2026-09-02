/**
 * The Hoza YT button and its in-page panel, on youtube.com itself.
 *
 * A pill sits beside YouTube's Subscribe button. Pages without one — the home
 * page, search, channels — get it in the top bar instead, so the button is on
 * every YouTube page rather than only on a video. Pressing it opens a small
 * dashboard anchored to it, with five sections: Video qualities, Audio
 * qualities, the main dashboard, About, and the live download list.
 *
 * Runs in the isolated world and imports nothing — Chromium content scripts
 * cannot be ES modules. Both the button and the panel live in their own shadow
 * roots, so YouTube's stylesheet cannot reach them and this file cannot leak
 * styles back into the page.
 *
 * The local Hoza YT server only accepts extension and loopback origins, so every
 * API call goes through the background worker rather than being made here.
 */

(() => {
  const FLAG = '__hozaPanelInstalled';
  if (window[FLAG]) return;
  window[FLAG] = true;

  const MSG = {
    ANALYZE: 'hoza:analyze',
    DOWNLOAD: 'hoza:download',
    JOBS: 'hoza:jobs',
    ABOUT: 'hoza:about',
    DASHBOARD: 'ui:dashboard',
<<<<<<< HEAD
    STATE: 'hoza:state:get',
    RETRY: 'hoza:state:retry',
    STATE_CHANGED: 'hoza:state:changed',
  };

  /* The connection to the local app, as a sentence rather than a diagnosis.
     The panel never explains a port, a process or a command: the app installs
     itself, starts itself, and either answers or does not. */
  const CONNECTION_UNKNOWN = {
    state: 'unknown',
    text: 'Checking…',
    ready: false,
    error: null,
    hint: null,
=======
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57
  };

  const SECTIONS = [
    { id: 'video', label: 'Video' },
    { id: 'audio', label: 'Audio' },
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'about', label: 'About' },
    { id: 'downloads', label: 'Downloads' },
  ];

  const JOB_POLL_FAST_MS = 1500; // something is downloading
  const JOB_POLL_IDLE_MS = 6000; // just keeping the tab badge honest
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /* ------------------------------------------------------------------ state */

  const state = {
    open: false,
    section: 'video',
    url: watchUrl(),
    analysis: null,
    analysisUrl: null,
    loading: false,
    error: null,
    videoChoice: null,
    audioChoice: null,
    submitting: false,
    about: null,
    aboutError: null,
    jobs: [],
    jobsError: null,
<<<<<<< HEAD
    connection: { ...CONNECTION_UNKNOWN },
=======
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57
  };

  let host = null; // panel host element
  let shadow = null;
  let refs = {}; // long-lived nodes inside the panel
  let buttonHost = null;
  let button = null;
  let placement = null; // which spot on the page the button is in
  let hostGuard = null;
  let jobTimer = null;
  let closeTimer = null;

  /* --------------------------------------------------------------- helpers */

  /** The canonical watch URL, or null when this page is not a video. */
  function watchUrl() {
    const { pathname, href } = location;
    if (pathname === '/watch') {
      const id = new URLSearchParams(location.search).get('v');
      return id ? `https://www.youtube.com/watch?v=${id}` : href;
    }
    if (pathname.startsWith('/shorts/')) {
      const id = pathname.split('/')[2];
      return id ? `https://www.youtube.com/watch?v=${id}` : href;
    }
    if (pathname.startsWith('/live/')) return href;
    return null;
  }

  /**
   * Ask the background worker. Never rejects: a missing local app is an
   * ordinary state the panel renders as a sentence.
   */
  function send(message) {
    return new Promise((resolve) => {
      const failure = (error, code) => resolve({ ok: false, error: { error, code, hint: null } });
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            failure('The extension was reloaded. Refresh this page to reconnect.', 'context_lost');
            return;
          }
          resolve(response ?? { ok: false, error: { error: 'No reply from the extension.' } });
        });
      } catch {
        failure('The extension was reloaded. Refresh this page to reconnect.', 'context_lost');
      }
    });
  }

  /** Errors arrive in two shapes — the server's and the extension's. */
  const errorText = (error) =>
    error?.error || error?.title || 'Something went wrong.';

<<<<<<< HEAD
  /** The connection, phrased as an error record the existing cards can render. */
  function connectionProblem() {
    return {
      error: state.connection.error || state.connection.text,
      hint: state.connection.hint,
      code: 'server_offline',
      retryable: true,
    };
  }

  /** Adopt a connection report and repaint whatever is showing it. */
  function applyConnection(report) {
    if (!report || typeof report !== 'object') return;
    const wasReady = state.connection.ready;
    state.connection = { ...CONNECTION_UNKNOWN, ...report };
    updateSubtitle();
    // Coming back after a restart is worth acting on: whatever failed while
    // the app was away can now succeed.
    if (!wasReady && state.connection.ready && state.open) {
      if (state.section === 'downloads') void refreshJobs();
      if (state.section === 'about') void loadAbout();
      if (!state.analysis && !state.loading) void loadAnalysis();
    }
  }

  /* The background worker owns the connection and announces every change, so
     the panel never polls for it. */
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === MSG.STATE_CHANGED) applyConnection(message);
  });

  async function loadConnection() {
    const report = await send({ type: MSG.STATE });
    if (report && report.state) applyConnection(report);
  }

=======
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  /**
   * Icons are built node by node rather than from markup: YouTube enforces
   * Trusted Types, and this keeps the panel clear of any HTML sink.
   */
  function icon(shapes, size = 18) {
    const node = document.createElementNS(SVG_NS, 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('width', String(size));
    node.setAttribute('height', String(size));
    node.setAttribute('fill', 'none');
    node.setAttribute('stroke', 'currentColor');
    node.setAttribute('stroke-width', '1.9');
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    node.setAttribute('aria-hidden', 'true');
    for (const [tag, attrs] of shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of Object.entries(attrs)) shape.setAttribute(name, String(value));
      node.append(shape);
    }
    return node;
  }

  const ICONS = {
    bolt: [['path', { d: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z' }]],
    video: [
      ['path', { d: 'M15.5 10.5 21 7.6v8.8l-5.5-2.9' }],
      ['rect', { x: 3, y: 6, width: 12.5, height: 12, rx: 2.5 }],
    ],
    audio: [
      ['path', { d: 'M9 17V4l11-2v13' }],
      ['circle', { cx: 6, cy: 17, r: 3 }],
      ['circle', { cx: 17, cy: 15, r: 3 }],
    ],
    dashboard: [
      ['rect', { x: 3, y: 3, width: 7.5, height: 7.5, rx: 2 }],
      ['rect', { x: 13.5, y: 3, width: 7.5, height: 7.5, rx: 2 }],
      ['rect', { x: 3, y: 13.5, width: 7.5, height: 7.5, rx: 2 }],
      ['rect', { x: 13.5, y: 13.5, width: 7.5, height: 7.5, rx: 2 }],
    ],
    about: [
      ['circle', { cx: 12, cy: 12, r: 9.5 }],
      ['path', { d: 'M12 16.5v-5' }],
      ['path', { d: 'M12 7.8h.01' }],
    ],
    downloads: [
      ['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }],
      ['path', { d: 'M7.5 10.5 12 15l4.5-4.5' }],
      ['path', { d: 'M12 15V3' }],
    ],
    download: [
      ['path', { d: 'M12 3v12' }],
      ['path', { d: 'm7 11 5 5 5-5' }],
      ['path', { d: 'M5 20h14' }],
    ],
    close: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
    refresh: [
      ['path', { d: 'M21 4v6h-6' }],
      ['path', { d: 'M20.1 14.5A8.5 8.5 0 1 1 18 6.1L21 9' }],
    ],
    check: [['path', { d: 'm20 6.5-11 11L4 12.5' }]],
    mail: [
      ['rect', { x: 2.5, y: 4.5, width: 19, height: 15, rx: 2.5 }],
      ['path', { d: 'm3 7 9 6 9-6' }],
    ],
    external: [
      ['path', { d: 'M18 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5.5' }],
      ['path', { d: 'M15 3h6v6' }],
      ['path', { d: 'M10 14 20.5 3.5' }],
    ],
    warning: [
      ['path', { d: 'M12 3.5 1.8 20.5h20.4L12 3.5Z' }],
      ['path', { d: 'M12 10v4' }],
      ['path', { d: 'M12 17.5h.01' }],
    ],
    person: [
      ['circle', { cx: 12, cy: 8, r: 4 }],
      ['path', { d: 'M4 20.5a8 8 0 0 1 16 0' }],
    ],
  };

  /* ------------------------------------------------------------ formatting */

  function humanSize(bytes) {
    if (!bytes || bytes < 0) return null;
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
  }

  function humanDuration(seconds) {
    if (!seconds || seconds < 0) return null;
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  const humanSpeed = (bytesPerSecond) =>
    bytesPerSecond ? `${humanSize(bytesPerSecond)}/s` : null;

  function humanEta(seconds) {
    if (!seconds || seconds < 0) return null;
    if (seconds < 60) return `${Math.round(seconds)}s left`;
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m}m left`;
    return `${Math.floor(m / 60)}h ${m % 60}m left`;
  }

  /** The line under a video quality: codec, frame rate, container. */
  function videoDetail(stream) {
    const parts = [];
    if (stream.codec) parts.push(stream.codec);
    if (stream.fps && stream.fps > 30) parts.push(`${Math.round(stream.fps)} fps`);
    if (stream.ext) parts.push(String(stream.ext).toUpperCase());
    if (stream.muxed) parts.push('video + audio');
    return parts.join(' · ');
  }

  function audioDetail(stream) {
    const parts = [];
    if (stream.codec) parts.push(stream.codec);
    if (stream.channel_label) parts.push(stream.channel_label);
    if (stream.asr) parts.push(`${(stream.asr / 1000).toFixed(1)} kHz`);
    if (stream.ext) parts.push(String(stream.ext).toUpperCase());
    if (stream.drc) parts.push('compressed range');
    return parts.join(' · ');
  }

  const sizeText = (stream) =>
    stream.filesize_human
      ? `${stream.filesize_estimated ? '≈ ' : ''}${stream.filesize_human}`
      : null;

  /* ---------------------------------------------------------------- styles */

  const PANEL_CSS = `
:host {
  all: initial;
  position: fixed;
  z-index: 2147483000;
  display: block;
  font-family: Roboto, "YouTube Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
:host([hidden]) { display: none; }
* { box-sizing: border-box; margin: 0; padding: 0; }

.panel {
  /* One ramp, used everywhere below. Deep navy glass, a single blue accent. */
  --line: rgba(255, 255, 255, 0.09);
  --line-2: rgba(255, 255, 255, 0.16);
  --fill: rgba(255, 255, 255, 0.04);
  --fill-2: rgba(255, 255, 255, 0.08);
  --text: #eaf0fd;
  --text-2: #94a4c6;
  --text-3: #6c7d9f;
  --blue: #2f7ef0;
  --blue-2: #62b0f8;
  --sky: #38bdf8;
  --accent: linear-gradient(135deg, #2563eb 0%, #38bdf8 100%);
  --accent-soft: rgba(47, 126, 240, 0.16);
  --glow: rgba(45, 120, 255, 0.85);
  --ok: #34d399;
  --warn: #fbbf24;
  --err: #fb7185;

  width: 396px;
  max-width: calc(100vw - 24px);
  max-height: var(--max-height, min(560px, calc(100vh - 96px)));
  display: flex;
  flex-direction: column;
  color: var(--text);
  background:
    radial-gradient(125% 90% at 0% 0%, rgba(47, 126, 240, 0.26) 0%, transparent 58%),
    radial-gradient(110% 85% at 100% 0%, rgba(56, 189, 248, 0.18) 0%, transparent 54%),
    radial-gradient(120% 90% at 88% 100%, rgba(124, 92, 255, 0.20) 0%, transparent 56%),
    linear-gradient(180deg, rgba(13, 21, 42, 0.88) 0%, rgba(6, 10, 22, 0.93) 100%);
  backdrop-filter: blur(30px) saturate(180%);
  -webkit-backdrop-filter: blur(30px) saturate(180%);
  border: 1px solid var(--line);
  border-radius: 24px;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.34),
    0 40px 92px -26px rgba(0, 0, 0, 0.82),
    0 0 0 1px rgba(45, 120, 255, 0.12);
  overflow: hidden;
  transform-origin: var(--origin, 50% 0%);
  animation: panelIn 320ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.panel.closing { animation: panelOut 140ms ease-in both; }

@keyframes panelIn {
  from { opacity: 0; transform: translateY(-10px) scale(0.955); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes panelOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to { opacity: 0; transform: translateY(-6px) scale(0.97); }
}

/* ---- header ---- */
.head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 14px 14px 12px;
  border-bottom: 1px solid var(--line);
}
/* A thread of blue light along the header's edge. */
.head::after {
  content: "";
  position: absolute;
  left: 14px; right: 14px; bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(98, 176, 248, 0.6), transparent);
}
.mark {
  width: 32px; height: 32px;
  flex: none;
  display: grid; place-items: center;
  border-radius: 11px;
  color: #fff;
  background: var(--accent);
  box-shadow: 0 6px 18px -6px var(--glow), inset 0 1px 0 rgba(255, 255, 255, 0.28);
}
.titles { flex: 1; min-width: 0; }
.titles b { display: block; font-size: 14px; font-weight: 600; letter-spacing: 0.2px; }
.titles span {
  display: block;
  font-size: 11.5px;
  color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.icon-btn {
  width: 30px; height: 30px;
  flex: none;
  display: grid; place-items: center;
  border: 1px solid transparent;
  border-radius: 10px;
  background: var(--fill);
  color: var(--text-2);
  cursor: pointer;
  transition: background 160ms ease, color 160ms ease, transform 160ms ease, border-color 160ms ease;
}
.icon-btn:hover {
  background: var(--accent-soft);
  border-color: rgba(98, 176, 248, 0.34);
  color: #fff;
}
.icon-btn:active { transform: scale(0.92); }
.icon-btn.spinning svg { animation: spin 900ms linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---- tabs ---- */
.tabs {
  position: relative;
  display: flex;
  gap: 2px;
  padding: 8px 10px 9px;
  border-bottom: 1px solid var(--line);
}
.slider {
  position: absolute;
  top: 8px; left: 0;
  height: 44px;
  border-radius: 11px;
  background: linear-gradient(135deg, rgba(37, 99, 235, 0.42) 0%, rgba(56, 189, 248, 0.26) 100%);
  box-shadow:
    inset 0 0 0 1px rgba(98, 176, 248, 0.48),
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    0 6px 18px -10px var(--glow);
  transition: transform 320ms cubic-bezier(0.16, 1, 0.3, 1), width 320ms cubic-bezier(0.16, 1, 0.3, 1);
  pointer-events: none;
}
.tab {
  position: relative;
  flex: 1;
  height: 44px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px;
  border: 0;
  border-radius: 11px;
  background: transparent;
  color: var(--text-3);
  font-family: inherit;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.2px;
  cursor: pointer;
  transition: color 200ms ease;
}
.tab svg { width: 15px; height: 15px; transition: transform 260ms cubic-bezier(0.16, 1, 0.3, 1); }
.tab:hover { color: var(--text); }
.tab:hover svg { transform: translateY(-1px); }
.tab[aria-selected="true"] { color: #fff; }
.tab .dot {
  position: absolute;
  top: 5px; right: 9px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 2px rgba(8, 13, 26, 0.9), 0 0 8px var(--ok);
  animation: pulse 1.8s ease-in-out infinite;
}
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

/* ---- body ---- */
.body {
  flex: 1;
  min-height: 132px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 12px;
  scrollbar-width: thin;
  scrollbar-color: rgba(98, 176, 248, 0.32) transparent;
}
.body::-webkit-scrollbar { width: 8px; }
.body::-webkit-scrollbar-thumb { background: rgba(98, 176, 248, 0.26); border-radius: 8px; }
.body::-webkit-scrollbar-thumb:hover { background: rgba(98, 176, 248, 0.46); }
.fade > * { animation: rise 340ms cubic-bezier(0.16, 1, 0.3, 1) both; }
@keyframes rise {
  from { opacity: 0; transform: translateY(7px); }
  to { opacity: 1; transform: none; }
}

/* ---- media card ---- */
.media {
  display: flex;
  gap: 10px;
  padding: 9px;
  margin-bottom: 10px;
  border-radius: 15px;
  background: var(--fill);
  border: 1px solid var(--line);
}
.media img {
  width: 76px; height: 44px;
  flex: none;
  object-fit: cover;
  border-radius: 9px;
  background: var(--fill-2);
}
.media div { min-width: 0; align-self: center; }
.media b {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.35;
}
.media span { display: block; margin-top: 3px; font-size: 11px; color: var(--text-2); }

/* ---- quality rows ---- */
.rows { display: flex; flex-direction: column; gap: 6px; }
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 13px;
  background: var(--fill);
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 180ms ease, border-color 180ms ease, transform 180ms ease, box-shadow 180ms ease;
}
.row:hover {
  background: var(--accent-soft);
  border-color: rgba(98, 176, 248, 0.3);
}
.row:active { transform: scale(0.988); }
.row[aria-checked="true"] {
  background: linear-gradient(135deg, rgba(37, 99, 235, 0.30) 0%, rgba(56, 189, 248, 0.16) 100%);
  border-color: rgba(98, 176, 248, 0.62);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 8px 24px -14px var(--glow);
}
.tick {
  width: 18px; height: 18px;
  flex: none;
  display: grid; place-items: center;
  border-radius: 50%;
  border: 1.6px solid var(--line-2);
  color: transparent;
  transition: border-color 180ms ease, background 180ms ease, color 180ms ease;
}
.tick svg { width: 11px; height: 11px; }
.row[aria-checked="true"] .tick {
  border-color: transparent;
  background: var(--accent);
  color: #fff;
  box-shadow: 0 3px 10px -3px var(--glow);
}
.row .label { flex: 1; min-width: 0; }
.row .label b { display: block; font-size: 13px; font-weight: 600; }
.row .label > span {
  display: block;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row .size { flex: none; font-size: 11.5px; color: var(--text-2); font-variant-numeric: tabular-nums; }
.badge {
  display: inline-block;
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.4px;
  vertical-align: 1px;
  background: rgba(255, 255, 255, 0.09);
  color: var(--text-2);
}
.badge.hdr { background: rgba(251, 191, 36, 0.18); color: var(--warn); }
.badge.top { background: rgba(56, 189, 248, 0.2); color: #7dd3fc; }
.badge.drc { background: rgba(255, 255, 255, 0.08); color: var(--text-3); }

/* ---- footer ---- */
.foot {
  padding: 10px 12px 12px;
  border-top: 1px solid var(--line);
  background: rgba(5, 9, 20, 0.5);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.cta {
  position: relative;
  width: 100%;
  height: 44px;
  display: flex; align-items: center; justify-content: center;
  gap: 8px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 14px;
  background: var(--accent);
  color: #fff;
  font-family: inherit;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.2px;
  cursor: pointer;
  overflow: hidden;
  box-shadow: 0 12px 28px -12px var(--glow), inset 0 1px 0 rgba(255, 255, 255, 0.26);
  transition: transform 180ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 180ms ease, filter 180ms ease;
}
.cta::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(100deg, transparent 30%, rgba(255, 255, 255, 0.34) 50%, transparent 70%);
  transform: translateX(-120%);
}
.cta:hover { transform: translateY(-1px); box-shadow: 0 18px 36px -14px var(--glow), inset 0 1px 0 rgba(255, 255, 255, 0.3); }
.cta:hover::after { animation: sweep 900ms ease; }
.cta:active { transform: translateY(0) scale(0.985); }
.cta:disabled { filter: grayscale(0.6) brightness(0.72); cursor: default; transform: none; box-shadow: none; }
.cta.ghost {
  background: var(--fill);
  border-color: var(--line-2);
  box-shadow: none;
}
.cta.ghost:hover { background: var(--accent-soft); border-color: rgba(98, 176, 248, 0.4); }
@keyframes sweep { to { transform: translateX(120%); } }
.foot .hint { margin-top: 7px; text-align: center; font-size: 11px; color: var(--text-3); }

/* ---- states ---- */
.state { padding: 26px 18px; text-align: center; }
.state svg { color: var(--text-3); margin-bottom: 10px; }
.state b { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; }
.state p { font-size: 11.5px; line-height: 1.55; color: var(--text-2); }
.state .cta { width: auto; height: 34px; padding: 0 16px; margin: 14px auto 0; font-size: 12px; }
.skeleton { display: flex; flex-direction: column; gap: 6px; }
.skeleton i {
  display: block;
  height: 46px;
  border-radius: 13px;
  background: linear-gradient(100deg, rgba(255,255,255,0.04) 30%, rgba(98,176,248,0.14) 50%, rgba(255,255,255,0.04) 70%);
  background-size: 220% 100%;
  animation: shimmer 1.25s ease-in-out infinite;
}
.skeleton i:nth-child(2) { animation-delay: 90ms; }
.skeleton i:nth-child(3) { animation-delay: 180ms; }
.skeleton i:nth-child(4) { animation-delay: 270ms; }
@keyframes shimmer { from { background-position: 130% 0; } to { background-position: -30% 0; } }

/* ---- about ---- */
.about-head {
  display: flex; align-items: center; gap: 11px;
  padding: 13px;
  border-radius: 15px;
  margin-bottom: 10px;
  background: linear-gradient(135deg, rgba(37, 99, 235, 0.22) 0%, rgba(56, 189, 248, 0.12) 100%);
  border: 1px solid rgba(98, 176, 248, 0.3);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
}
.about-head .mark { width: 40px; height: 40px; border-radius: 14px; }
.about-head b { display: block; font-size: 14px; font-weight: 600; }
.about-head span { display: block; margin-top: 2px; font-size: 11.5px; color: var(--text-2); }
.facts { display: flex; flex-direction: column; gap: 1px; border-radius: 13px; overflow: hidden; }
.fact {
  display: flex; align-items: baseline; gap: 12px;
  padding: 8px 11px;
  background: var(--fill);
  font-size: 11.5px;
}
.fact dt { flex: none; width: 96px; color: var(--text-3); }
.fact dd { flex: 1; min-width: 0; color: var(--text); word-break: break-word; }
.mailto {
  display: flex; align-items: center; justify-content: center; gap: 8px;
  height: 38px;
  margin-top: 10px;
  border-radius: 13px;
  border: 1px solid var(--line-2);
  background: var(--fill);
  color: #fff;
  font-size: 12.5px;
  font-weight: 500;
  text-decoration: none;
  transition: background 180ms ease, transform 180ms ease, border-color 180ms ease;
}
.mailto:hover {
  background: var(--accent-soft);
  border-color: rgba(98, 176, 248, 0.4);
  transform: translateY(-1px);
}
.legal { margin-top: 10px; font-size: 10.5px; line-height: 1.6; color: var(--text-3); text-align: center; }

/* ---- jobs ---- */
.job {
  padding: 10px 11px;
  border-radius: 13px;
  background: var(--fill);
  border: 1px solid var(--line);
}
.job-top { display: flex; align-items: center; gap: 8px; }
.job-top b {
  flex: 1; min-width: 0;
  font-size: 12px; font-weight: 500;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.pill {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-2);
}
.pill.downloading, .pill.analyzing, .pill.merging, .pill.queued {
  background: rgba(47, 126, 240, 0.24); color: #9ecbff;
}
.pill.completed { background: rgba(52, 211, 153, 0.16); color: var(--ok); }
.pill.failed { background: rgba(251, 113, 133, 0.16); color: var(--err); }
.pill.paused { background: rgba(251, 191, 36, 0.16); color: var(--warn); }
.track {
  height: 5px;
  margin: 9px 0 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden;
}
.bar {
  height: 100%;
  width: 0;
  border-radius: 999px;
  background: var(--accent);
  box-shadow: 0 0 12px -2px var(--glow);
  transition: width 420ms cubic-bezier(0.16, 1, 0.3, 1);
}
.bar.done { background: linear-gradient(90deg, #34d399, #22b8a0); box-shadow: none; }
.bar.live {
  background-image: var(--accent), repeating-linear-gradient(115deg, rgba(255,255,255,0.24) 0 8px, transparent 8px 16px);
  background-blend-mode: overlay;
  animation: flow 900ms linear infinite;
}
@keyframes flow { to { background-position: 32px 0, 32px 0; } }
.job-foot { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--text-3); font-variant-numeric: tabular-nums; }

/* ---- toast ---- */
.toast {
  position: absolute;
  left: 12px; right: 12px; bottom: 12px;
  display: flex; align-items: center; gap: 9px;
  padding: 10px 12px;
  border-radius: 13px;
  background: rgba(9, 15, 30, 0.92);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid var(--line-2);
  box-shadow: 0 16px 40px -16px rgba(0, 0, 0, 0.92);
  font-size: 12px;
  animation: toastIn 300ms cubic-bezier(0.16, 1, 0.3, 1) both;
}
.toast.err { border-color: rgba(251, 113, 133, 0.45); }
.toast svg { flex: none; }
.toast.ok svg { color: var(--ok); }
.toast.err svg { color: var(--err); }
@keyframes toastIn {
  from { opacity: 0; transform: translateY(12px) scale(0.96); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .panel, .fade > *, .toast { animation: none !important; }
  .slider, .bar, .cta, .row, .icon-btn { transition: none !important; }
  .cta::after, .skeleton i, .tab .dot { animation: none !important; }
}
`;

  const BUTTON_CSS = `
:host { all: initial; display: inline-flex; vertical-align: middle; }
* { box-sizing: border-box; }

/**
 * Dark indigo through violet, translucent, blurred against whatever is behind
 * it. Four things move the whole time it is on screen: the gradient drifts,
 * a sheen crosses it, the glow breathes and the mark floats.
 */
button {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 36px;
  padding: 0 15px 0 8px;
  border: 1px solid rgba(163, 148, 255, 0.36);
  border-radius: 18px;
  background: linear-gradient(
    118deg,
    rgba(30, 32, 96, 0.82) 0%,
    rgba(34, 52, 132, 0.82) 26%,
    rgba(76, 44, 148, 0.82) 52%,
    rgba(38, 46, 138, 0.82) 76%,
    rgba(28, 30, 92, 0.82) 100%);
  background-size: 280% 280%;
  backdrop-filter: blur(16px) saturate(170%);
  -webkit-backdrop-filter: blur(16px) saturate(170%);
  color: #fff;
  font-family: Roboto, "YouTube Sans", -apple-system, "Segoe UI", Arial, sans-serif;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.2px;
  white-space: nowrap;
  cursor: pointer;
  overflow: hidden;
  isolation: isolate;
  box-shadow:
    0 8px 22px -10px rgba(104, 78, 232, 0.95),
    inset 0 1px 0 rgba(255, 255, 255, 0.2);
  transition: transform 220ms cubic-bezier(0.16, 1, 0.3, 1), border-color 220ms ease, filter 220ms ease;
  animation:
    buttonIn 420ms cubic-bezier(0.16, 1, 0.3, 1) both,
    drift 11s ease-in-out infinite,
    aura 4.2s ease-in-out 600ms infinite;
}

/* The sheen. Paints over the background, under the label, on a loop. */
button::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  background: linear-gradient(100deg,
    transparent 34%,
    rgba(198, 184, 255, 0.34) 50%,
    transparent 66%);
  transform: translateX(-120%);
  animation: sweep 4.6s ease-in-out 1s infinite;
}

/* A violet edge light along the top, so the glass has a lit rim. */
button::after {
  content: "";
  position: absolute;
  left: 12%; right: 12%; top: 0;
  height: 1px;
  z-index: -1;
  background: linear-gradient(90deg, transparent, rgba(196, 181, 253, 0.85), transparent);
  animation: rim 4.2s ease-in-out infinite;
}

button:hover {
  transform: translateY(-2px);
  border-color: rgba(196, 181, 253, 0.75);
  filter: brightness(1.16) saturate(1.12);
}
button:active { transform: translateY(0) scale(0.96); }
button:focus-visible { outline: 2px solid #c4b5fd; outline-offset: 2px; }
button[aria-expanded="true"] {
  border-color: rgba(196, 181, 253, 0.85);
  filter: brightness(1.1);
}

/* The mark sits on its own darker chip, so it reads against the glass. */
button img {
  width: 24px;
  height: 24px;
  padding: 3px;
  border-radius: 8px;
  background: rgba(8, 10, 30, 0.5);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.16);
  animation: bob 3.4s ease-in-out infinite;
}

@keyframes drift {
  0%, 100% { background-position: 0% 50%; }
  50% { background-position: 100% 50%; }
}
@keyframes aura {
  0%, 100% {
    box-shadow:
      0 8px 22px -10px rgba(104, 78, 232, 0.95),
      inset 0 1px 0 rgba(255, 255, 255, 0.2);
  }
  50% {
    box-shadow:
      0 12px 28px -10px rgba(124, 92, 255, 1),
      0 0 0 4px rgba(124, 92, 255, 0.16),
      inset 0 1px 0 rgba(255, 255, 255, 0.26);
  }
}
@keyframes sweep {
  0% { transform: translateX(-120%); }
  55%, 100% { transform: translateX(120%); }
}
@keyframes rim {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
@keyframes bob {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-1.5px); }
}
@keyframes buttonIn {
  from { opacity: 0; transform: translateY(6px) scale(0.94); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  button, button::before, button::after, button img { animation: none !important; }
  button::before { opacity: 0; }
  button { transition: none !important; }
}
`;

  /* ---------------------------------------------------------------- button */

  /**
   * Is this element actually on screen? A plain rect test is not enough:
   * YouTube gives some wrappers `display: contents`, so the element itself
   * generates no box even though what it renders is perfectly visible.
   */
  function rendered(node) {
    if (!node?.isConnected) return false;
    if (node.getClientRects().length) return true;
    for (const child of node.querySelectorAll('*')) {
      if (child.getClientRects().length) return true;
    }
    return false;
  }

  function firstRendered(selectors) {
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (rendered(node)) return node;
      }
    }
    return null;
  }

  /** YouTube's Subscribe button, in the order the watch page nests it. */
  const findSubscribe = () => firstRendered([
    'ytd-watch-metadata #owner ytd-subscribe-button-renderer',
    'ytd-watch-metadata #subscribe-button',
    'ytd-watch-metadata #subscribe-button button',
    '#owner #subscribe-button',
    '#owner #subscribe-button button',
    '#top-row #subscribe-button',
    '#top-row #subscribe-button button',
    'ytd-reel-player-overlay-renderer #subscribe-button',
    'ytd-watch-flexy ytd-subscribe-button-renderer',
    'ytd-watch-flexy #subscribe-button',
  ]);

  const findLikeActions = () => firstRendered([
    '#top-level-buttons-computed',
    '#actions-inner #top-level-buttons-computed',
    'ytd-menu-renderer#top-level-buttons-computed',
  ]);

  /** The button row in YouTube's top bar, which every page has. */
  const findTopBar = () => firstRendered([
    'ytd-masthead #end #buttons',
    'ytd-masthead #buttons',
    '#masthead #end #buttons',
    'ytd-masthead #end',
    '#masthead #end',
    '#masthead-container #end',
  ]);

  const isWatchPage = () => watchUrl() !== null;

  /**
   * Where the button may sit, best spot first.
   *
   * The first four are the watch page's top row: beside Like, Share and Save,
   * then progressively further out in the same row, which exist only because
   * that button group is width-constrained and will clip a button it did not
   * create. They are offered on a video and nowhere else — a stray Subscribe
   * button in a home page shelf or a channel hovercard is a spot that vanishes
   * the moment YouTube recycles the card, which is how the button used to go
   * missing on the home page.
   *
   * Every other page — home, search, channels, playlists — has the top bar,
   * which YouTube keeps up permanently. And if even that is unavailable, the
   * button floats clear of the page, where nothing on it can reach the button
   * at all. One of these always holds, so no page is left without a button.
   */
  const ANCHORS = [
    {
      where: 'actions',
      when: isWatchPage,
      find: findLikeActions,
      place: (node, at) => at.append(node),
    },
    {
      where: 'actions-inner',
      when: isWatchPage,
      find: () => firstRendered(['ytd-watch-metadata #actions-inner', '#actions-inner']),
      place: (node, at) => at.append(node),
    },
    {
      where: 'row',
      when: isWatchPage,
      find: () => firstRendered(['ytd-watch-metadata #top-row', '#top-row']),
      place: (node, at) => at.append(node),
    },
    {
      where: 'subscribe',
      when: isWatchPage,
      find: findSubscribe,
      place: (node, at) => at.parentElement?.insertBefore(node, at.nextSibling),
    },
    {
      where: 'masthead',
      find: findTopBar,
      place: (node, at) => at.prepend(node),
    },
    {
      where: 'float',
      find: () => document.body,
      place: (node, at) => at.append(node),
    },
  ];

  /**
   * Laid out inline and marked `!important`, so no stylesheet on the page can
   * take the button out of the flow, shrink it away or fade it out.
   */
  const HOST_BASE = [
    'display:inline-flex !important',
    'visibility:visible !important',
    'opacity:1 !important',
    'align-items:center !important',
    'flex:0 0 auto !important',
    'width:auto !important',
    'height:auto !important',
    'max-width:none !important',
    'min-width:0',
    'pointer-events:auto !important',
    'transform:none !important',
    'clip-path:none !important',
  ];

  /** In a video's action row the button comes last, after Like and Share. */
  const HOST_STYLE = [
    ...HOST_BASE,
    'margin-left:8px !important',
    'vertical-align:middle',
    'position:static',
    'order:99',
  ].join(';');

  /** In the top bar it leads the row, so its margin is on the other side. */
  const MASTHEAD_STYLE = [
    ...HOST_BASE,
    'margin:0 8px 0 0 !important',
    'vertical-align:middle',
    'position:static',
    'order:-1',
  ].join(';');

  /** Floating: pinned to the window, out of reach of the page's layout. */
  const FLOAT_STYLE = [
    ...HOST_BASE,
    'position:fixed !important',
    'right:24px !important',
    'bottom:24px !important',
    'left:auto !important',
    'top:auto !important',
    'margin:0 !important',
    'z-index:2147482999 !important',
  ].join(';');

  function hostStyleFor(where) {
    if (where === 'float') return FLOAT_STYLE;
    if (where === 'masthead') return MASTHEAD_STYLE;
    return HOST_STYLE;
  }

  /**
   * What, if anything, is keeping the button off the screen.
   *
   * Returns the clipping element, the string 'size' or 'viewport', or null
   * when the button is genuinely visible. A rect with width is not proof of
   * anything: an ancestor that hides its overflow will happily lay a child
   * out and then cut it off.
   */
  function whatHides(node) {
    if (!node?.isConnected) return 'detached';
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return 'size';

    // The floating pill is laid out against the window, so no ancestor's
    // overflow applies to it and the only question is whether it is on screen.
    const fixed = getComputedStyle(node).position === 'fixed';

    if (!fixed) {
      for (let parent = node.parentElement; parent && parent !== document.body;
           parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.display === 'none' || style.visibility === 'hidden') return parent;
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;

        const box = parent.getBoundingClientRect();
        if (!box.width && !box.height) continue;
        const cut =
          rect.right > box.right + 1 ||
          rect.left < box.left - 1 ||
          rect.bottom > box.bottom + 1 ||
          rect.top < box.top - 1;
        if (cut) return parent;
      }
    }

    if (rect.right > window.innerWidth + 1 || rect.left < -1) return 'viewport';
    // Vertically, only the pinned pill can be off screen: a button in the page
    // scrolling out of view is the page working, not the button being hidden.
    if (fixed && (rect.bottom > window.innerHeight + 1 || rect.top < -1)) return 'viewport';
    return null;
  }

  /**
   * Try to make the row show the button: let the clipping ancestor overflow,
   * and let the row wrap rather than cut. Returns true once nothing hides it.
   *
   * A region YouTube has deliberately switched off is left alone — that is the
   * page saying the whole area is gone, and the answer to it is a different
   * spot, not a hidden area forced back on. What is opened up is opened again
   * whenever YouTube's own re-render wipes it, so a spot that worked once
   * never goes permanently bad.
   */
  function makeRoom(node) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const hider = whatHides(node);
      if (!hider) return true;
      if (!(hider instanceof Element)) return false;

      const style = getComputedStyle(hider);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      if (hider.style.overflow === 'visible') return false; // opened, still hides

      hider.style.setProperty('overflow', 'visible', 'important');
      hider.style.setProperty('flex-wrap', 'wrap', 'important');
      hider.style.setProperty('max-width', 'none', 'important');
    }
    return !whatHides(node);
  }

  /** Build the launcher in its own shadow root. */
  function buildLauncher(variant) {
    const styleText = hostStyleFor(variant);
    const hostNode = document.createElement('div');
    hostNode.dataset.hozaButton = variant;
    hostNode.style.cssText = styleText;
    const root = hostNode.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = BUTTON_CSS;

    const control = document.createElement('button');
    control.type = 'button';
    control.className = variant;
    control.title = 'Hoza YT — pick a quality';
    control.setAttribute('aria-expanded', String(state.open));
    control.setAttribute('aria-haspopup', 'dialog');

    const mark = document.createElement('img');
    mark.alt = '';
    mark.width = 18;
    mark.height = 18;
    mark.src = chrome.runtime.getURL('icons/icon-48.png');
    control.append(mark, el('span', null, 'Hoza YT'));
    control.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });

    root.append(style, control);
    return { hostNode, control, style: styleText };
  }

  /** Spots that just refused the button, so it stops hammering at them. */
  const refused = new WeakMap();
  const REFUSED_MS = 5000;

  /**
   * Put the button in the best spot this page currently offers.
   *
   * Called over and over, by everything below, and written to be called that
   * way: when the button is already sitting in the best spot on offer this
   * does nothing at all. Anything less — gone from the page, clipped out of
   * sight, or parked in a lesser spot because the good one had not rendered
   * yet — and the button is placed again.
   */
  function mountButton() {
    const anchors = ANCHORS.filter((anchor) => !anchor.when || anchor.when());
    const rank = placement ? anchors.findIndex((anchor) => anchor.where === placement) : -1;
    // A spot that is not on this page's list at all — a video's action row,
    // after navigating home — counts as no spot, however intact it looks.
    const held = rank !== -1 && !!buttonHost?.isConnected && !whatHides(buttonHost);

    for (let i = 0; i < anchors.length; i += 1) {
      // This spot, or one below it: what the button already has is as good.
      if (held && i >= rank) return true;

      const anchor = anchors[i];
      const target = anchor.find();
      if (!target) continue;

      // Only humour a spot's recent refusal while the button is up elsewhere.
      // With nothing on screen, every spot is worth another try immediately.
      const since = refused.get(target);
      if (held && since != null && Date.now() - since < REFUSED_MS) continue;

      const built = buildLauncher(anchor.where);
      anchor.place(built.hostNode, target);

      // Occupying a spot is not the same as being seen in it.
      if (!makeRoom(built.hostNode)) {
        built.hostNode.remove();
        refused.set(target, Date.now());
        continue;
      }

      refused.delete(target);
      if (buttonHost !== built.hostNode) buttonHost?.remove();
      buttonHost = built.hostNode;
      button = built.control;
      placement = anchor.where;
      guardHost(built.style);
      console.info(`[Hoza YT] button mounted (${placement})`);
      if (state.open) position();
      return true;
    }

    return held;
  }

  const GUARD_WATCH = { attributes: true, attributeFilter: ['style', 'class', 'hidden'] };

  /**
   * YouTube rebuilds these rows as you navigate and can strip attributes from
   * anything it finds there. If the inline layout is edited away, or the
   * button is marked hidden, put it back.
   *
   * Two details keep the repair from turning on itself. The style is compared
   * against what the browser made of it rather than the text handed in — set
   * `a:b !important` and it reads back as `a: b !important;`, so a raw
   * comparison never matches and the guard rewrites for ever. And the guard
   * stops watching while it repairs, because the repair is itself an
   * attribute change: watching that is an endless loop of observer callbacks,
   * and since they run as microtasks it is one the page cannot get out of —
   * scrolling, navigation and this very button all stop with it.
   */
  function guardHost(styleText) {
    hostGuard?.disconnect();
    if (!buttonHost) return;

    const node = buttonHost;
    node.style.cssText = styleText;
    const expected = node.getAttribute('style');

    const guard = new MutationObserver(() => {
      if (!node.isConnected) return;
      guard.disconnect();
      if (node.hasAttribute('hidden')) node.removeAttribute('hidden');
      if (node.getAttribute('style') !== expected) node.style.cssText = styleText;
      guard.observe(node, GUARD_WATCH);
    });
    guard.observe(node, GUARD_WATCH);
    hostGuard = guard;
  }

  /**
   * Re-check the button: on the page, seen, and in the best spot the page
   * offers. mountButton does nothing when all three already hold, so this is
   * safe to call as often as anything cares to.
   */
  function verifyPlacement() {
    mountButton();
  }

  function setExpanded(open) {
    button?.setAttribute('aria-expanded', String(open));
  }

  /* ----------------------------------------------------------------- panel */

  function buildPanel() {
    host = document.createElement('div');
    host.dataset.hozaPanel = 'true';
    host.style.cssText = 'position:fixed;z-index:2147483000;display:block;inset:auto';
    host.setAttribute('aria-hidden', 'false');
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = PANEL_CSS;

    const panel = el('div', 'panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Hoza YT');

    /* header */
    const head = el('div', 'head');
    const mark = el('div', 'mark');
    mark.append(icon(ICONS.bolt, 17));
    const titles = el('div', 'titles');
    const subtitle = el('span', null, 'Choose a quality and download');
    titles.append(el('b', null, 'Hoza YT'), subtitle);

    const refresh = el('button', 'icon-btn');
    refresh.type = 'button';
    refresh.title = 'Analyse this video again';
    refresh.append(icon(ICONS.refresh, 15));
    refresh.addEventListener('click', () => loadAnalysis({ refresh: true }));

    const close = el('button', 'icon-btn');
    close.type = 'button';
    close.title = 'Close';
    close.append(icon(ICONS.close, 15));
    close.addEventListener('click', () => closePanel());

    head.append(mark, titles, refresh, close);

    /* tabs */
    const tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    const slider = el('div', 'slider');
    tabs.append(slider);

    const tabButtons = new Map();
    for (const section of SECTIONS) {
      const tab = el('button', 'tab');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.dataset.section = section.id;
      tab.append(icon(ICONS[section.id], 15), el('span', null, section.label));
      tab.addEventListener('click', () => selectSection(section.id));
      tabs.append(tab);
      tabButtons.set(section.id, tab);
    }

    const body = el('div', 'body');
    const foot = el('div', 'foot');

    panel.append(head, tabs, body, foot);
    shadow.append(style, panel);

    refs = { panel, body, foot, tabs, slider, tabButtons, subtitle, refresh };
    document.documentElement.append(host);
  }

  /** Slide the highlight behind the active tab. */
  function moveSlider() {
    const tab = refs.tabButtons?.get(state.section);
    if (!tab) return;
    refs.slider.style.width = `${tab.offsetWidth}px`;
    refs.slider.style.transform = `translateX(${tab.offsetLeft}px)`;
  }

  /**
   * Directly beneath the button, centred on it, tracking it as the page
   * scrolls so the two stay together. It relocates for one reason only: a
   * button sitting low in the window — the floating pill — has no room
   * beneath it, and there the panel opens upwards instead.
   */
  function position() {
    if (!host || !state.open) return;
    const rect = buttonHost?.isConnected ? buttonHost.getBoundingClientRect() : null;
    if (!rect?.width) return; // nothing to anchor to — leave it where it is

    const width = refs.panel.offsetWidth || 396;
    const margin = 12;

    const centre = rect.left + rect.width / 2;
    const left = Math.min(Math.max(centre - width / 2, margin), window.innerWidth - width - margin);
    const below = window.innerHeight - rect.bottom - 10 - margin;
    const above = rect.top - 10 - margin;
    const up = below < 240 && above > below;

    host.style.left = `${Math.round(left)}px`;
    if (up) {
      host.style.top = 'auto';
      host.style.bottom = `${Math.round(window.innerHeight - rect.top + 10)}px`;
    } else {
      host.style.bottom = 'auto';
      host.style.top = `${Math.round(rect.bottom + 10)}px`;
    }

    // Only as tall as the room on that side of the button allows.
    const room = up ? above : below;
    refs.panel.style.setProperty(
      '--max-height',
      `${Math.round(Math.max(240, Math.min(560, room)))}px`,
    );

    // Grow from the point directly under — or over — the button.
    const originX = Math.min(Math.max(centre - left, 16), width - 16);
    refs.panel.style.setProperty('--origin', `${Math.round(originX)}px ${up ? '100%' : '0%'}`);
  }

  /* ------------------------------------------------------------ open/close */

  function toggle() {
    if (state.open) closePanel();
    else openPanel();
  }

  function openPanel() {
    if (!host) buildPanel();
    clearTimeout(closeTimer);

    state.open = true;
    state.url = watchUrl() ?? state.url;
    host.style.display = 'block';
    host.setAttribute('aria-hidden', 'false');
    refs.panel.classList.remove('closing');
    setExpanded(true);

    // A fresh entrance every time, rather than a one-off on first build.
    refs.panel.style.animation = 'none';
    void refs.panel.offsetWidth;
    refs.panel.style.animation = '';

    selectSection(state.section, { silent: true });
    position();
    requestAnimationFrame(moveSlider);

    if (state.url && state.analysisUrl !== state.url && !state.loading) loadAnalysis();
<<<<<<< HEAD
    void loadConnection();
=======
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57
    startJobPolling();

    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', position, { passive: true });
    window.addEventListener('scroll', position, { passive: true, capture: true });
  }

  function closePanel() {
    if (!state.open) return;
    state.open = false;
    setExpanded(false);
    stopJobPolling();

    refs.panel.classList.add('closing');
    closeTimer = setTimeout(() => {
      if (!state.open) {
        host.style.display = 'none';
        host.setAttribute('aria-hidden', 'true');
      }
    }, 150);

    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', position, true);
  }

  function onKeydown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closePanel();
    }
  }

  /** A click anywhere but the panel or its button closes it. */
  function onPointerDown(event) {
    const path = event.composedPath();
    if (path.includes(host) || path.includes(buttonHost)) return;
    closePanel();
  }

  /* ---------------------------------------------------------------- render */

  function selectSection(id, { silent = false } = {}) {
    state.section = id;
    for (const [key, tab] of refs.tabButtons) {
      tab.setAttribute('aria-selected', String(key === id));
    }
    moveSlider();
    render();

    // The dashboard tab is an action: it takes the user there, as asked.
    if (id === 'dashboard' && !silent) openDashboard();
    if (id === 'about' && !state.about && !state.aboutError) loadAbout();
    if (id === 'downloads') refreshJobs();
  }

  function render() {
    if (!refs.body) return;
    refs.body.textContent = '';
    refs.foot.textContent = '';
    refs.foot.hidden = true;
    refs.cta = null;
    refs.ctaHint = null;
    refs.body.classList.remove('fade');
    void refs.body.offsetWidth;
    refs.body.classList.add('fade');
    refs.body.scrollTop = 0;

    const renderer = {
      video: renderVideo,
      audio: renderAudio,
      dashboard: renderDashboard,
      about: renderAbout,
      downloads: renderDownloads,
    }[state.section];

    renderer?.();
    updateSubtitle();
  }

  function updateSubtitle() {
    if (!refs.subtitle) return;
<<<<<<< HEAD
    // A connection that is not ready is the most useful thing the header can
    // say, so it outranks everything else.
    if (!state.connection.ready && state.connection.state !== 'unknown') {
      refs.subtitle.textContent = state.connection.text;
      return;
    }
=======
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57
    if (state.loading) refs.subtitle.textContent = 'Reading the available qualities…';
    else if (state.analysis) {
      const video = state.analysis.video?.length ?? 0;
      const audio = state.analysis.audio?.length ?? 0;
      refs.subtitle.textContent = `${video} video · ${audio} audio qualities`;
    } else refs.subtitle.textContent = 'Choose a quality and download';
  }

  function stateCard(iconName, title, message, action) {
    const card = el('div', 'state');
    card.append(icon(ICONS[iconName], 26), el('b', null, title));
    if (message) card.append(el('p', null, message));
    if (action) {
      const cta = el('button', 'cta ghost', action.label);
      cta.type = 'button';
      cta.addEventListener('click', action.onClick);
      card.append(cta);
    }
    return card;
  }

  function skeleton() {
    const wrap = el('div', 'skeleton');
    for (let i = 0; i < 4; i += 1) wrap.append(el('i'));
    return wrap;
  }

  function mediaCard() {
    const media = state.analysis;
    if (!media) return null;
    const card = el('div', 'media');
    if (media.thumbnail) {
      const img = document.createElement('img');
      img.src = media.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      card.append(img);
    }
    const text = el('div');
    text.append(el('b', null, media.title || 'Untitled'));
    const facts = [media.uploader, humanDuration(media.duration)].filter(Boolean).join(' · ');
    if (facts) text.append(el('span', null, facts));
    card.append(text);
    return card;
  }

  /** Shared shell for the two quality sections. */
  function renderQualities({ streams, empty, rowFor, chosen, onChoose, cta }) {
    if (!state.url) {
      refs.body.append(stateCard(
        'video',
        'Open a video first',
        'Play something on YouTube, then this panel will list every quality it offers.',
      ));
      return;
    }
    if (state.loading) {
      refs.body.append(skeleton());
      return;
    }
    if (state.error) {
      refs.body.append(stateCard('warning', errorText(state.error), state.error.hint, {
        label: 'Try again',
        onClick: () => loadAnalysis({ refresh: true }),
      }));
      return;
    }
    if (!state.analysis) {
      refs.body.append(stateCard('refresh', 'Not analysed yet', null, {
        label: 'Analyse this video',
        onClick: () => loadAnalysis(),
      }));
      return;
    }
    if (!streams.length) {
      refs.body.append(stateCard('warning', empty, 'Try another video, or open the main dashboard.'));
      return;
    }

    const card = mediaCard();
    if (card) refs.body.append(card);

    const rows = el('div', 'rows');
    streams.forEach((stream, index) => {
      const row = el('button', 'row');
      row.type = 'button';
      row.setAttribute('role', 'radio');
      row.setAttribute('aria-checked', String(stream.format_id === chosen));
      row.style.animationDelay = `${Math.min(index, 12) * 22}ms`;

      const tick = el('div', 'tick');
      tick.append(icon(ICONS.check, 11));

      const described = rowFor(stream);
      const label = el('div', 'label');
      const name = el('b', null, described.title);
      for (const badge of described.badges) {
        name.append(el('span', `badge ${badge.kind}`, badge.text));
      }
      label.append(name, el('span', null, described.detail));

      row.append(tick, label);
      const size = sizeText(stream);
      if (size) row.append(el('div', 'size', size));

      row.addEventListener('click', () => {
        onChoose(stream.format_id);
        for (const sibling of rows.children) sibling.setAttribute('aria-checked', 'false');
        row.setAttribute('aria-checked', 'true');
        updateCta();
      });
      rows.append(row);
    });
    refs.body.append(rows);

    refs.foot.hidden = false;
    const download = el('button', 'cta');
    download.type = 'button';
    download.append(icon(ICONS.download, 17), el('span', null, cta.label));
    download.addEventListener('click', cta.onClick);
    const hint = el('div', 'hint');
    refs.foot.append(download, hint);
    refs.cta = download;
    refs.ctaHint = hint;
    updateCta();
  }

  /** Keep the footer button telling the truth about the current choice. */
  function updateCta() {
    if (!refs.cta || refs.foot.hidden) return;
    const isVideo = state.section === 'video';
    const streams = (isVideo ? state.analysis?.video : state.analysis?.audio) ?? [];
    const chosen = streams.find(
      (stream) => stream.format_id === (isVideo ? state.videoChoice : state.audioChoice),
    );
    const label = refs.cta.querySelector('span');

    if (state.submitting) {
      label.textContent = 'Sending to Hoza YT…';
      refs.cta.disabled = true;
    } else if (!chosen) {
      label.textContent = isVideo ? 'Choose a quality' : 'Choose an audio quality';
      refs.cta.disabled = true;
    } else {
      const name = isVideo
        ? `${chosen.label}${chosen.hdr ? ' HDR' : ''}`
        : `${chosen.abr ? `${Math.round(chosen.abr)} kbps` : 'Audio'}`;
      label.textContent = `Download ${name}`;
      refs.cta.disabled = false;
    }

    refs.ctaHint.textContent = chosen
      ? [sizeText(chosen), isVideo ? 'saved by the Hoza YT app' : 'audio only'].filter(Boolean).join(' · ')
      : 'Pick one of the qualities above';
  }

  function renderVideo() {
    const streams = state.analysis?.video ?? [];
    renderQualities({
      streams,
      empty: 'This video has no separate video streams.',
      chosen: state.videoChoice,
      onChoose: (id) => { state.videoChoice = id; },
      rowFor: (stream) => {
        const badges = [];
        if (stream === streams[0]) badges.push({ kind: 'top', text: 'BEST' });
        if (stream.hdr) badges.push({ kind: 'hdr', text: stream.dynamic_range || 'HDR' });
        return { title: stream.label || `${stream.height}p`, badges, detail: videoDetail(stream) };
      },
      cta: { label: 'Choose a quality', onClick: () => startDownload('video') },
    });
  }

  function renderAudio() {
    const streams = state.analysis?.audio ?? [];
    const best = streams.find((stream) => !stream.drc) ?? streams[0];
    renderQualities({
      streams,
      empty: 'This video has no separate audio track.',
      chosen: state.audioChoice,
      onChoose: (id) => { state.audioChoice = id; },
      rowFor: (stream) => {
        const badges = [];
        if (stream === best) badges.push({ kind: 'top', text: 'BEST' });
        if (stream.language) badges.push({ kind: '', text: String(stream.language).toUpperCase() });
        if (stream.drc) badges.push({ kind: 'drc', text: 'DRC' });
        return {
          title: stream.abr ? `${Math.round(stream.abr)} kbps` : 'Audio',
          badges,
          detail: audioDetail(stream),
        };
      },
      cta: { label: 'Choose an audio quality', onClick: () => startDownload('audio') },
    });
  }

  function renderDashboard() {
    const card = el('div', 'about-head');
    const mark = el('div', 'mark');
    mark.append(icon(ICONS.dashboard, 19));
    const text = el('div');
    text.append(
      el('b', null, 'Main dashboard'),
      el('span', null, 'Queue, history, settings, logs and diagnostics.'),
    );
    card.append(mark, text);

    const open = el('button', 'cta');
    open.type = 'button';
    open.style.marginTop = '10px';
    open.append(icon(ICONS.external, 16), el('span', null, 'Open the main dashboard'));
    open.addEventListener('click', () => openDashboard());

    const note = el('p', null,
<<<<<<< HEAD
      'The dashboard opens in a new tab with this video already loaded.');
=======
      'The dashboard opens in a new tab at 127.0.0.1:8765 with this video already loaded.');
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57
    note.style.cssText = 'margin-top:10px;font-size:11px;line-height:1.6;color:#7f89a3;text-align:center';

    refs.body.append(card, open, note);
  }

  function renderAbout() {
    if (!state.about && !state.aboutError) {
      refs.body.append(skeleton());
      return;
    }

    const card = el('div', 'about-head');
    const mark = el('div', 'mark');
    mark.append(icon(ICONS.bolt, 19));
    const text = el('div');
    const about = state.about ?? {};
    text.append(
      el('b', null, about.app || 'Hoza YT'),
      el('span', null, about.description || 'A local media downloading and processing application.'),
    );
    card.append(mark, text);
    refs.body.append(card);

    const extension = chrome.runtime?.getManifest?.() ?? {};
    const facts = el('dl', 'facts');
    const rows = [
      ['Developer', about.developer || 'Rahoz Osman'],
      ['Email', about.contact || 'hozahoza2001@gmail.com'],
      ['App version', about.version ? `v${about.version}` : null],
      ['Extension', extension.version ? `v${extension.version}` : null],
      ['Extractor', about.yt_dlp ? `yt-dlp ${about.yt_dlp}` : null],
      ['FFmpeg', about.ffmpeg ? `${about.ffmpeg}${about.ffmpeg_source ? ` (${about.ffmpeg_source})` : ''}` : null],
      ['Python', about.python || null],
      ['Platform', about.platform || null],
      ['Database', about.database || null],
    ];
    for (const [term, value] of rows) {
      if (!value) continue;
      const fact = el('div', 'fact');
      fact.append(el('dt', null, term), el('dd', null, value));
      facts.append(fact);
    }
    refs.body.append(facts);

    const email = about.contact || 'hozahoza2001@gmail.com';
    const mailto = el('a', 'mailto');
    mailto.href = `mailto:${email}?subject=${encodeURIComponent('Hoza YT')}`;
    mailto.target = '_blank';
    mailto.rel = 'noreferrer';
    mailto.append(icon(ICONS.mail, 15), el('span', null, `Email ${about.developer || 'the developer'}`));
    refs.body.append(mailto);

    if (state.aboutError) {
      const warn = el('p', 'legal', `${errorText(state.aboutError)} Showing what the extension knows.`);
      refs.body.append(warn);
    }

    refs.body.append(el('div', 'legal',
      about.license || 'For personal use with media you are authorised to download.'));
  }

  function renderDownloads() {
    if (state.jobsError) {
      refs.body.append(stateCard('warning', errorText(state.jobsError), state.jobsError.hint, {
        label: 'Try again',
        onClick: () => refreshJobs(),
      }));
      return;
    }
    if (!state.jobs.length) {
      refs.body.append(stateCard(
        'downloads',
        'No downloads yet',
        'Pick a video or audio quality and it will appear here with live progress.',
      ));
      return;
    }

    const list = el('div', 'rows');
    state.jobs.forEach((job, index) => {
      const row = jobRow(job);
      row.style.animationDelay = `${Math.min(index, 12) * 22}ms`;
      list.append(row);
    });
    refs.body.append(list);

    refs.foot.hidden = false;
    const open = el('button', 'cta ghost');
    open.type = 'button';
    open.append(icon(ICONS.external, 15), el('span', null, 'Manage in the dashboard'));
    open.addEventListener('click', () => openDashboard());
    refs.foot.append(open);
  }

  function jobRow(job) {
    const row = el('div', 'job');
    row.dataset.jobId = job.id;

    const top = el('div', 'job-top');
    top.append(
      el('b', null, job.title || job.url || 'Download'),
      el('span', `pill ${job.status}`, job.status),
    );

    const track = el('div', 'track');
    const bar = el('div', 'bar');
    track.append(bar);

    const foot = el('div', 'job-foot');
    foot.append(el('span'), el('span'));

    row.append(top, track, foot);
    updateJobRow(row, job);
    return row;
  }

  function updateJobRow(row, job) {
    const pill = row.querySelector('.pill');
    pill.className = `pill ${job.status}`;
    pill.textContent = job.status;
    row.querySelector('b').textContent = job.title || job.url || 'Download';

    const bar = row.querySelector('.bar');
    const percent = job.status === 'completed' ? 100 : Math.max(0, Math.min(100, job.progress || 0));
    bar.style.width = `${percent}%`;
    bar.classList.toggle('live', job.status === 'downloading');
    bar.classList.toggle('done', job.status === 'completed');

    const [left, right] = row.querySelectorAll('.job-foot span');
    left.textContent = [job.quality_label, `${Math.round(percent)}%`].filter(Boolean).join(' · ');
    right.textContent = job.status === 'downloading'
      ? [humanSpeed(job.speed), humanEta(job.eta)].filter(Boolean).join(' · ')
      : [humanSize(job.downloaded), humanSize(job.total) && `of ${humanSize(job.total)}`]
        .filter(Boolean).join(' ');
  }

  /** Patch rows in place so progress bars animate instead of restarting. */
  function paintJobs() {
    if (state.section !== 'downloads') return;
    const list = refs.body.querySelector('.rows');
    if (!list || state.jobsError || !state.jobs.length) {
      render();
      return;
    }
    const seen = new Set();
    for (const job of state.jobs) {
      seen.add(job.id);
      const existing = list.querySelector(`[data-job-id="${CSS.escape(job.id)}"]`);
      if (existing) updateJobRow(existing, job);
      else list.append(jobRow(job));
    }
    for (const row of [...list.children]) {
      if (!seen.has(row.dataset.jobId)) row.remove();
    }
  }

  function toast(message, kind = 'ok') {
    const existing = refs.panel.querySelector('.toast');
    existing?.remove();
    const node = el('div', `toast ${kind}`);
    node.append(icon(kind === 'ok' ? ICONS.check : ICONS.warning, 16), el('span', null, message));
    refs.panel.append(node);
    setTimeout(() => node.remove(), 4200);
  }

  /* ------------------------------------------------------------------ data */

  async function loadAnalysis({ refresh = false } = {}) {
    const url = watchUrl();
    if (!url) return;

    state.url = url;
    state.loading = true;
    state.error = null;
    refs.refresh?.classList.add('spinning');
    if (['video', 'audio'].includes(state.section)) render();
    else updateSubtitle();

    const response = await send({ type: MSG.ANALYZE, url, refresh });

    state.loading = false;
    refs.refresh?.classList.remove('spinning');

    // A navigation may have overtaken this request.
    if (watchUrl() !== url) return;

    if (response.ok && response.data) {
      state.analysis = response.data;
      state.analysisUrl = url;
      state.error = null;
      const audio = response.data.audio ?? [];
      state.videoChoice = response.data.video?.[0]?.format_id ?? null;
      state.audioChoice = (audio.find((stream) => !stream.drc) ?? audio[0])?.format_id ?? null;
    } else {
      state.analysis = null;
      state.analysisUrl = null;
      state.error = response.error ?? { error: 'The video could not be analysed.' };
    }

    if (['video', 'audio'].includes(state.section)) render();
    else updateSubtitle();
  }

  async function loadAbout() {
    const response = await send({ type: MSG.ABOUT });
    if (response.ok && response.data) {
      state.about = response.data;
      state.aboutError = null;
    } else {
      state.about = null;
<<<<<<< HEAD
      state.aboutError = response.error ?? connectionProblem();
=======
      state.aboutError = response.error ?? { error: 'The local app is not running.' };
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57
    }
    if (state.section === 'about') render();
  }

  async function refreshJobs() {
    const response = await send({ type: MSG.JOBS, limit: 12 });
    if (response.ok && response.data) {
      state.jobs = response.data.jobs ?? [];
      state.jobsError = null;
    } else {
      state.jobs = [];
<<<<<<< HEAD
      state.jobsError = response.error ?? connectionProblem();
=======
      state.jobsError = response.error ?? { error: 'The local app is not running.' };
>>>>>>> fb8a48e5deb82a316748a4a71b00a624c0adfc57
    }
    updateActivityDot();
    if (state.section === 'downloads') paintJobs();
  }

  const ACTIVE = new Set(['queued', 'analyzing', 'downloading', 'merging', 'paused']);

  /** A green dot on the Downloads tab while anything is still running. */
  function updateActivityDot() {
    const tab = refs.tabButtons?.get('downloads');
    if (!tab) return;
    const active = state.jobs.some((job) => ACTIVE.has(job.status));
    const dot = tab.querySelector('.dot');
    if (active && !dot) tab.append(el('i', 'dot'));
    else if (!active && dot) dot.remove();
  }

  function startJobPolling() {
    stopJobPolling();
    void pollJobs();
  }

  async function pollJobs() {
    await refreshJobs();
    if (!state.open) return;
    const busy = state.jobs.some((job) => ACTIVE.has(job.status));
    const delay = busy && state.section === 'downloads' ? JOB_POLL_FAST_MS : JOB_POLL_IDLE_MS;
    jobTimer = setTimeout(pollJobs, delay);
  }

  function stopJobPolling() {
    if (jobTimer) clearTimeout(jobTimer);
    jobTimer = null;
  }

  async function startDownload(kind) {
    const formatId = kind === 'video' ? state.videoChoice : state.audioChoice;
    if (!formatId || state.submitting) return;

    state.submitting = true;
    updateCta();

    const selection = kind === 'video'
      ? { kind: 'video', preset: 'custom', video_format_id: formatId }
      : { kind: 'audio', preset: 'custom', audio_format_id: formatId };

    const response = await send({
      type: MSG.DOWNLOAD,
      url: state.analysis?.webpage_url ?? state.url,
      selection,
    });

    state.submitting = false;
    updateCta();

    if (response.ok) {
      toast(`Queued · ${response.data?.quality_label ?? kind}`);
      void refreshJobs();
      selectSection('downloads');
    } else {
      toast(errorText(response.error), 'err');
    }
  }

  function openDashboard() {
    void send({ type: MSG.DASHBOARD, url: state.url ?? location.href, title: document.title });
  }

  /* ------------------------------------------------------- page lifecycle */

  /** YouTube swaps videos without rebuilding the document. */
  function onNavigate() {
    const url = watchUrl();
    if (url === state.url) return;

    state.url = url;
    state.analysis = null;
    state.analysisUrl = null;
    state.error = null;
    state.videoChoice = null;
    state.audioChoice = null;

    if (state.open) {
      if (url) loadAnalysis();
      else render();
    }
  }

  let mountTimer = null;
  function scheduleMount() {
    if (mountTimer != null) return;
    mountTimer = setTimeout(() => {
      mountTimer = null;
      mountButton();
    }, 250);
  }

  /**
   * A watch page assembles its owner row in stages, and the home page streams
   * its top bar in just as late, so one attempt is a coin toss. These retries
   * are bounded and cheap, and stop mattering the moment the button is sitting
   * where it belongs. A new call replaces the previous ladder, so the chattier
   * YouTube events cannot pile timers up.
   */
  let remountTimers = [];
  function remountSoon() {
    for (const timer of remountTimers) clearTimeout(timer);
    remountTimers = [0, 250, 600, 1200, 2500, 4000, 6500, 9000]
      .map((delay) => setTimeout(mountButton, delay));
  }

  // YouTube announces a navigation in more than one way and not every one of
  // them fires on every page, the home page least reliably of all. Listening
  // to all of them costs nothing: mountButton is its own no-op.
  for (const event of ['yt-navigate-finish', 'yt-page-data-updated', 'yt-navigate-redirect']) {
    document.addEventListener(event, () => {
      onNavigate();
      remountSoon();
    });
  }
  window.addEventListener('popstate', onNavigate);

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function wrappedHistoryMethod() {
      const result = original.apply(this, arguments);
      onNavigate();
      remountSoon();
      return result;
    };
  }

  // YouTube rebuilds the row as you navigate. This fires very often, so the
  // test is a single property read; the costlier visibility check runs from
  // scheduleMount, and only when the button has actually gone.
  new MutationObserver(() => {
    if (!buttonHost?.isConnected) scheduleMount();
  }).observe(document.documentElement, { childList: true, subtree: true });

  // A resize is what tips a constrained row into clipping the button, so
  // re-check once the new layout has settled.
  let verifyTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(verifyPlacement, 200);
  }, { passive: true });

  // Full screen and the miniplayer both move the anchor out from under us.
  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) closePanel();
  });

  // A tab in the background may have missed the page being rebuilt entirely.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') remountSoon();
  });

  // The last line of defence. Everything above waits to be told; this simply
  // keeps looking, so a button that goes missing for a reason nobody
  // anticipated is back within a second and a half regardless. It costs one
  // visibility check against a button that is almost always already fine.
  setInterval(() => {
    if (document.visibilityState === 'visible') verifyPlacement();
  }, 1500);

  mountButton();
  remountSoon();
})();
