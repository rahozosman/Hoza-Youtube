/**
 * Filename generation.
 *
 * Renders a user template, then sanitises the result so it is valid on
 * Windows, macOS and Linux alike — the strictest rules win, because a library
 * synced between machines should not break on one of them.
 */

import {
  codecFamily,
  qualityLabel,
  extensionForContainer,
  domainOf,
  humanDuration,
} from './format-utils.js';
import { StreamType } from './constants.js';

/** Tokens a template may use, with the description shown in Settings. */
export const TEMPLATE_TOKENS = [
  { token: '{title}', description: 'Media title, or the page title as a fallback' },
  { token: '{quality}', description: 'Resolution label, e.g. 1080p — audio bitrate for audio' },
  { token: '{resolution}', description: 'Pixel dimensions, e.g. 1920x1080' },
  { token: '{codec}', description: 'Video codec short name, e.g. H264' },
  { token: '{audiocodec}', description: 'Audio codec short name, e.g. AAC' },
  { token: '{container}', description: 'Container, e.g. mp4' },
  { token: '{fps}', description: 'Frames per second, when the source declares it' },
  { token: '{duration}', description: 'Duration as m-ss' },
  { token: '{domain}', description: 'Site the media came from' },
  { token: '{date}', description: "Today's date, YYYY-MM-DD" },
  { token: '{time}', description: 'Current time, HH-MM' },
  { token: '{index}', description: 'Position in the queue, when several are saved at once' },
];

export const DEFAULT_TEMPLATE = '{title} - {quality}';

/** Characters no major filesystem accepts, plus the C0 control range. */
// eslint-disable-next-line no-control-regex
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;

/** Reserved device names on Windows, checked without the extension. */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/** Leave headroom under the 255-byte limit for the " (12)" dedupe suffix. */
const MAX_STEM_LENGTH = 180;

/**
 * Make one path segment safe. Never returns an empty string — an input that
 * sanitises away entirely becomes "media".
 */
export function sanitizeSegment(input, fallback = 'media') {
  let text = String(input ?? '')
    .replace(ILLEGAL, ' ')
    // Directory traversal and separators must not survive a template.
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim();

  // Windows rejects names ending in a dot or a space.
  text = text.replace(/[. ]+$/g, '').replace(/^[. ]+/g, '');

  if (!text) return fallback;

  if (RESERVED.has(text.toLowerCase())) text = `${text}_`;

  if (text.length > MAX_STEM_LENGTH) {
    text = text.slice(0, MAX_STEM_LENGTH).replace(/[. ]+$/g, '');
  }

  return text || fallback;
}

/**
 * Sanitise a relative directory path for chrome.downloads, which rejects
 * absolute paths and any parent traversal.
 */
export function sanitizeSubfolder(input) {
  if (!input) return '';
  return String(input)
    .replace(/\\/g, '/')
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => sanitizeSegment(part, 'folder'))
    .join('/');
}

function two(n) {
  return String(n).padStart(2, '0');
}

/** Build the substitution map for one stream. */
export function buildTokenValues({ stream, media, index = 1, now = new Date() }) {
  const isAudio = stream?.type === StreamType.AUDIO;

  let quality = '';
  if (isAudio) {
    const rate = stream.audioBitrate ?? stream.bandwidth;
    quality = Number.isFinite(rate) && rate > 0 ? `${Math.round(rate / 1000)}kbps` : 'audio';
  } else {
    quality = qualityLabel(stream?.height, { withSuffix: false }) ?? '';
  }

  const resolution =
    Number.isFinite(stream?.width) && Number.isFinite(stream?.height)
      ? `${stream.width}x${stream.height}`
      : '';

  return {
    title: media?.title || media?.pageTitle || 'Media',
    quality,
    resolution,
    codec: codecFamily(stream?.videoCodec)?.short ?? '',
    audiocodec: codecFamily(stream?.audioCodec)?.short ?? '',
    container: stream?.container ?? '',
    fps: Number.isFinite(stream?.fps) ? String(Math.round(stream.fps)) : '',
    duration: (humanDuration(media?.duration) ?? '').replace(/:/g, '-'),
    domain: domainOf(media?.pageUrl ?? media?.url) ?? '',
    date: `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`,
    time: `${two(now.getHours())}-${two(now.getMinutes())}`,
    index: String(index),
  };
}

/**
 * Render a template. Unknown tokens are left alone so a typo is visible in the
 * result rather than silently swallowed; empty known tokens collapse together
 * with any separator left stranded beside them.
 */
export function renderTemplate(template, values) {
  const raw = String(template || DEFAULT_TEMPLATE).replace(
    /\{([a-z]+)\}/gi,
    (match, name) => {
      const key = name.toLowerCase();
      return key in values ? values[key] : match;
    },
  );

  return raw
    // " - " left dangling by an empty token
    .replace(/\s*[-–—]\s*(?=$)/g, '')
    .replace(/^\s*[-–—]\s*/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Full filename for a stream: rendered template, sanitised, with the correct
 * extension for the container.
 */
export function buildFilename({ template, stream, media, index = 1, subfolder = '' }) {
  const values = buildTokenValues({ stream, media, index });
  const stem = sanitizeSegment(renderTemplate(template, values), 'media');
  const ext = extensionForContainer(stream?.container);
  const folder = sanitizeSubfolder(subfolder);
  const name = `${stem}.${ext}`;
  return folder ? `${folder}/${name}` : name;
}

/** Split "folder/name.ext" into its parts. */
export function splitFilename(filename) {
  const normalised = String(filename ?? '').replace(/\\/g, '/');
  const slash = normalised.lastIndexOf('/');
  const folder = slash < 0 ? '' : normalised.slice(0, slash);
  const base = slash < 0 ? normalised : normalised.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0
    ? { folder, stem: base, ext: '' }
    : { folder, stem: base.slice(0, dot), ext: base.slice(dot + 1) };
}

/**
 * Add or bump a " (n)" suffix: `Video.mp4` -> `Video (1).mp4` -> `Video (2).mp4`.
 * Matches how the OS itself disambiguates, so the result looks unsurprising.
 */
export function nextAvailableName(filename, taken) {
  const isTaken =
    taken instanceof Set
      ? (candidate) => taken.has(candidate.toLowerCase())
      : (candidate) => taken(candidate);

  if (!isTaken(filename)) return filename;

  const { folder, stem, ext } = splitFilename(filename);
  const existing = /^(.*?)\s\((\d+)\)$/.exec(stem);
  const base = existing ? existing[1] : stem;
  let counter = existing ? Number(existing[2]) : 0;

  for (let attempt = 0; attempt < 1000; attempt += 1) {
    counter += 1;
    const stemWithCounter = `${base} (${counter})`;
    const name = ext ? `${stemWithCounter}.${ext}` : stemWithCounter;
    const candidate = folder ? `${folder}/${name}` : name;
    if (!isTaken(candidate)) return candidate;
  }
  // Pathological case: fall back to a timestamp, which cannot collide in practice.
  const stamped = `${base} (${Date.now()})`;
  const name = ext ? `${stamped}.${ext}` : stamped;
  return folder ? `${folder}/${name}` : name;
}

/** Preview a template against a representative stream, for the Settings page. */
export function previewTemplate(template) {
  const stream = {
    type: StreamType.MUXED,
    height: 1080,
    width: 1920,
    videoCodec: 'avc1.640028',
    audioCodec: 'mp4a.40.2',
    container: 'mp4',
    fps: 30,
  };
  const media = {
    title: 'How Lenses Bend Light',
    pageUrl: 'https://example.com/watch',
    duration: 763,
  };
  return buildFilename({ template, stream, media });
}
