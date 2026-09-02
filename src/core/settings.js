/**
 * Settings schema and defaults.
 *
 * Everything lives in `chrome.storage.local`. Nothing is synced to a server,
 * and nothing here records what the user watched — only how they want the
 * extension to behave.
 */

import { SmartMode } from './constants.js';
import { DEFAULT_TEMPLATE } from './filename.js';

export const DUPLICATE_POLICY = {
  ASK: 'ask',
  RENAME: 'rename',
  REPLACE: 'replace',
  SKIP: 'skip',
};

export const THEME = {
  SYSTEM: 'system',
  DARK: 'dark',
  LIGHT: 'light',
};

export const DEFAULTS = Object.freeze({
  general: {
    smartMode: SmartMode.BALANCED,
    preferredHeight: 1080,
    preferredContainer: 'mp4',
    preferredVideoCodec: null,
    notifications: true,
    notifyOnComplete: true,
    notifyOnFailure: true,
    oneClickEnabled: true,
  },
  downloads: {
    maxConcurrent: 3,
    autoStart: true,
    subfolder: '',
    askForLocation: false,
    filenameTemplate: DEFAULT_TEMPLATE,
    duplicatePolicy: DUPLICATE_POLICY.ASK,
    retryLimit: 2,
    segmentConcurrency: 4,
  },
  appearance: {
    theme: THEME.SYSTEM,
    compact: false,
    animations: true,
    accent: 'violet',
  },
  detection: {
    enabled: true,
    scanOnOpen: true,
    watchNetwork: true,
    includeShortMedia: false,
    minDurationSeconds: 0,
  },
  advanced: {
    debugLogging: false,
    keepHistory: true,
    historyLimit: 500,
  },
});

/** Bounds enforced on load, so a hand-edited value cannot break the runtime. */
const NUMERIC_BOUNDS = {
  'downloads.maxConcurrent': [1, 10],
  'downloads.retryLimit': [0, 10],
  'downloads.segmentConcurrency': [1, 8],
  'general.preferredHeight': [144, 4320],
  'advanced.historyLimit': [0, 5000],
  'detection.minDurationSeconds': [0, 3600],
};

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Deep-merge stored values over the defaults, keeping unknown keys out. */
export function mergeSettings(stored) {
  const out = structuredCloneish(DEFAULTS);
  if (!isPlainObject(stored)) return out;

  for (const section of Object.keys(DEFAULTS)) {
    const storedSection = stored[section];
    if (!isPlainObject(storedSection)) continue;
    for (const key of Object.keys(DEFAULTS[section])) {
      if (!(key in storedSection)) continue;
      const value = storedSection[key];
      const fallback = DEFAULTS[section][key];
      if (value === null && fallback === null) {
        out[section][key] = null;
      } else if (typeof fallback === 'boolean') {
        out[section][key] = Boolean(value);
      } else if (typeof fallback === 'number') {
        out[section][key] = clampNumber(`${section}.${key}`, value, fallback);
      } else if (typeof fallback === 'string' || fallback === null) {
        out[section][key] = value == null ? fallback : String(value);
      }
    }
  }
  return out;
}

function clampNumber(path, value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const bounds = NUMERIC_BOUNDS[path];
  if (!bounds) return n;
  return Math.min(bounds[1], Math.max(bounds[0], Math.round(n)));
}

/** `structuredClone` is not available in every context we run in. */
function structuredCloneish(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Per-site overrides, keyed by origin. */
export const SITE_DEFAULTS = Object.freeze({
  detection: true,
  autoAnalyze: true,
  smartMode: null, // null means "inherit the global preference"
});

export function mergeSitePrefs(stored) {
  if (!isPlainObject(stored)) return { ...SITE_DEFAULTS };
  return {
    detection: stored.detection !== false,
    autoAnalyze: stored.autoAnalyze !== false,
    smartMode: stored.smartMode ?? null,
  };
}

/** Origin key used for per-site preferences: "https://example.com". */
export function originKey(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

/** Match pattern granting access to one origin, for permissions.request. */
export function originPattern(url) {
  const origin = originKey(url);
  return origin ? `${origin}/*` : null;
}
