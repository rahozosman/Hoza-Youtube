/**
 * Format helpers: human-readable numbers, codec identification, container
 * detection and resolution labelling. Pure functions, no browser APIs, so the
 * service worker, offscreen document and UI pages can all share them.
 */

import { CONTAINERS, MEDIA_EXTENSIONS, MANIFEST_EXTENSIONS } from './constants.js';

const KB = 1024;

export function humanBytes(bytes, digits = 1) {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < KB) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / KB;
  let unit = 0;
  while (value >= KB && unit < units.length - 1) {
    value /= KB;
    unit += 1;
  }
  const d = value >= 100 ? 0 : digits;
  return `${value.toFixed(d)} ${units[unit]}`;
}

export function humanBitrate(bitsPerSecond) {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

export function humanDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function humanSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return `${humanBytes(bytesPerSecond, 1)}/s`;
}

export function humanEta(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)}m left`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m left`;
}

export function humanDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today ${time}`;
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`;
}

/* ------------------------------------------------------------------ codecs */

/**
 * Split an RFC 6381 codecs string ("avc1.640028,mp4a.40.2") into a video and
 * an audio entry. Unknown entries are ignored rather than guessed at.
 */
export function splitCodecs(codecsString) {
  const out = { video: null, audio: null };
  if (!codecsString) return out;
  for (const raw of String(codecsString).split(',')) {
    const codec = raw.trim();
    if (!codec) continue;
    const family = codecFamily(codec);
    if (!family) continue;
    if (family.kind === 'video' && !out.video) out.video = codec;
    if (family.kind === 'audio' && !out.audio) out.audio = codec;
  }
  return out;
}

/**
 * Identify a codec string. `efficiency` is compression efficiency relative to
 * H.264 (higher means more quality per bit); `compatibility` is how widely the
 * result will play back without extra software.
 */
export function codecFamily(codec) {
  const c = String(codec ?? '').toLowerCase();
  if (!c) return null;

  // Video
  if (c.startsWith('avc1') || c.startsWith('avc3') || c === 'h264' || c === 'h.264') {
    return { kind: 'video', name: 'H.264', short: 'H264', efficiency: 1.0, compatibility: 1.0 };
  }
  if (c.startsWith('hev1') || c.startsWith('hvc1') || c === 'h265' || c === 'hevc') {
    return { kind: 'video', name: 'H.265', short: 'HEVC', efficiency: 1.35, compatibility: 0.55 };
  }
  if (c.startsWith('dvh1') || c.startsWith('dvhe')) {
    return { kind: 'video', name: 'Dolby Vision', short: 'DV', efficiency: 1.35, compatibility: 0.4 };
  }
  if (c.startsWith('av01') || c === 'av1') {
    return { kind: 'video', name: 'AV1', short: 'AV1', efficiency: 1.5, compatibility: 0.65 };
  }
  if (c.startsWith('vp09') || c === 'vp9') {
    return { kind: 'video', name: 'VP9', short: 'VP9', efficiency: 1.25, compatibility: 0.8 };
  }
  if (c.startsWith('vp08') || c === 'vp8') {
    return { kind: 'video', name: 'VP8', short: 'VP8', efficiency: 0.8, compatibility: 0.75 };
  }
  if (c.startsWith('theora')) {
    return { kind: 'video', name: 'Theora', short: 'THEO', efficiency: 0.6, compatibility: 0.4 };
  }

  // Audio
  if (c.startsWith('mp4a.40.2') || c.startsWith('mp4a.40.02')) {
    return { kind: 'audio', name: 'AAC-LC', short: 'AAC', efficiency: 1.0, compatibility: 1.0 };
  }
  if (c.startsWith('mp4a.40.5') || c.startsWith('mp4a.40.29')) {
    return { kind: 'audio', name: 'HE-AAC', short: 'AAC', efficiency: 1.3, compatibility: 0.9 };
  }
  if (c.startsWith('mp4a')) {
    return { kind: 'audio', name: 'AAC', short: 'AAC', efficiency: 1.0, compatibility: 1.0 };
  }
  if (c.startsWith('opus')) {
    return { kind: 'audio', name: 'Opus', short: 'OPUS', efficiency: 1.4, compatibility: 0.8 };
  }
  if (c.startsWith('vorbis')) {
    return { kind: 'audio', name: 'Vorbis', short: 'VORB', efficiency: 1.1, compatibility: 0.7 };
  }
  if (c.startsWith('ec-3')) {
    return { kind: 'audio', name: 'E-AC-3', short: 'EAC3', efficiency: 1.1, compatibility: 0.6 };
  }
  if (c.startsWith('ac-3')) {
    return { kind: 'audio', name: 'AC-3', short: 'AC3', efficiency: 0.9, compatibility: 0.6 };
  }
  if (c.startsWith('mp3') || c.startsWith('mp4a.69') || c.startsWith('mp4a.6b')) {
    return { kind: 'audio', name: 'MP3', short: 'MP3', efficiency: 0.7, compatibility: 1.0 };
  }
  if (c.startsWith('flac')) {
    return { kind: 'audio', name: 'FLAC', short: 'FLAC', efficiency: 2.0, compatibility: 0.7 };
  }
  if (c.startsWith('alac')) {
    return { kind: 'audio', name: 'ALAC', short: 'ALAC', efficiency: 2.0, compatibility: 0.5 };
  }
  if (c.startsWith('pcm') || c.startsWith('lpcm')) {
    return { kind: 'audio', name: 'PCM', short: 'PCM', efficiency: 3.0, compatibility: 0.8 };
  }
  return null;
}

/** Short display label for a codec string, or null when unrecognised. */
export function codecLabel(codec) {
  return codecFamily(codec)?.short ?? null;
}

/** True for codecs that carry no lossy bitrate ceiling worth reporting. */
export function isLosslessAudio(codec) {
  const name = codecFamily(codec)?.name;
  return name === 'FLAC' || name === 'ALAC' || name === 'PCM';
}

/* -------------------------------------------------------------- containers */

const MIME_CONTAINER = new Map([
  ['video/mp4', 'mp4'],
  ['video/x-m4v', 'mp4'],
  ['video/quicktime', 'mov'],
  ['video/webm', 'webm'],
  ['video/x-matroska', 'mkv'],
  ['video/mp2t', 'ts'],
  ['video/ogg', 'ogv'],
  ['audio/mp4', 'm4a'],
  ['audio/x-m4a', 'm4a'],
  ['audio/aac', 'aac'],
  ['audio/aacp', 'aac'],
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/ogg', 'ogg'],
  ['audio/opus', 'opus'],
  ['audio/webm', 'weba'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/wave', 'wav'],
  ['audio/flac', 'flac'],
  ['audio/x-flac', 'flac'],
]);

/** Container from a MIME type, ignoring any parameters. */
export function containerFromMime(mime) {
  if (!mime) return null;
  const base = String(mime).split(';')[0].trim().toLowerCase();
  return MIME_CONTAINER.get(base) ?? null;
}

/** Lowercased path extension of a URL, without the dot. */
export function extensionOf(url) {
  try {
    const { pathname } = new URL(url);
    const last = pathname.split('/').pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot < 0 || dot === last.length - 1) return null;
    return last.slice(dot + 1).toLowerCase();
  } catch {
    return null;
  }
}

/** Best guess at the container, preferring the declared MIME over the URL. */
export function containerOf(url, mime) {
  const fromMime = containerFromMime(mime);
  if (fromMime) return fromMime;
  const ext = extensionOf(url);
  if (ext && CONTAINERS.includes(ext)) return ext;
  if (ext && MEDIA_EXTENSIONS.has(ext)) return ext;
  return null;
}

/** File extension to write for a container. */
export function extensionForContainer(container) {
  if (!container) return 'bin';
  if (container === 'weba') return 'webm';
  return container;
}

export function isManifestUrl(url) {
  const ext = extensionOf(url);
  return !!ext && MANIFEST_EXTENSIONS.has(ext);
}

export function isMediaUrl(url) {
  const ext = extensionOf(url);
  return !!ext && MEDIA_EXTENSIONS.has(ext);
}

/* -------------------------------------------------------------- resolution */

/** Standard rungs, largest first. Used to snap odd heights onto a known name. */
const LADDER = [
  { height: 4320, label: '4320p', suffix: '8K' },
  { height: 2160, label: '2160p', suffix: '4K' },
  { height: 1440, label: '1440p', suffix: 'QHD' },
  { height: 1080, label: '1080p', suffix: 'Full HD' },
  { height: 720, label: '720p', suffix: 'HD' },
  { height: 576, label: '576p', suffix: null },
  { height: 480, label: '480p', suffix: null },
  { height: 360, label: '360p', suffix: null },
  { height: 240, label: '240p', suffix: null },
  { height: 144, label: '144p', suffix: null },
];

/**
 * Snap a real height onto the nearest standard rung, but only when it is
 * within 12% — an unusual height keeps its own number rather than being
 * mislabelled as something the source never offered.
 */
export function snapHeight(height) {
  if (!Number.isFinite(height) || height <= 0) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const rung of LADDER) {
    const delta = Math.abs(rung.height - height);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = rung;
    }
  }
  if (best && bestDelta / best.height <= 0.12) return best;
  return null;
}

/** "1080p Full HD", or "812p" when the height matches no standard rung. */
export function qualityLabel(height, { withSuffix = true } = {}) {
  if (!Number.isFinite(height) || height <= 0) return null;
  const rung = snapHeight(height);
  if (!rung) return `${Math.round(height)}p`;
  return withSuffix && rung.suffix ? `${rung.label} ${rung.suffix}` : rung.label;
}

/** Short form for dense rows: "1080p", "4K". */
export function shortQualityLabel(height) {
  const rung = snapHeight(height);
  if (!rung) return Number.isFinite(height) && height > 0 ? `${Math.round(height)}p` : '—';
  return rung.height >= 2160 ? rung.suffix : rung.label;
}

/** Nearest of the conventional audio bitrate rungs, for display only. */
export function audioBitrateLabel(bitsPerSecond, codec) {
  if (isLosslessAudio(codec)) return 'Lossless';
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

/** Frames per second from a DASH `frameRate` value, which may be "30000/1001". */
export function parseFrameRate(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.includes('/')) {
    const [num, den] = text.split('/').map(Number);
    if (Number.isFinite(num) && Number.isFinite(den) && den !== 0) {
      return Math.round((num / den) * 100) / 100;
    }
    return null;
  }
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** Round an fps for display: 29.97 reads as 30, 59.94 as 60. */
export function displayFps(fps) {
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const rounded = Math.round(fps);
  return Math.abs(fps - rounded) < 0.5 ? rounded : Math.round(fps * 100) / 100;
}

/** Estimated byte size from a bitrate and a duration. */
export function estimateSize(bitsPerSecond, durationSeconds) {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return null;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return Math.round((bitsPerSecond / 8) * durationSeconds);
}

/** Hostname without a leading www., for display and filename templates. */
export function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return null;
  }
}

/** Resolve a possibly-relative URI against a base, tolerating bad input. */
export function resolveUrl(uri, baseUrl) {
  if (!uri) return null;
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}
