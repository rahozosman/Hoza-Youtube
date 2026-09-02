/**
 * Storage layer.
 *
 * A thin wrapper over `chrome.storage.local` with an in-memory cache, so the
 * service worker can read settings synchronously after the first load without
 * awaiting on every message. Everything stays on the device.
 */

import { api } from './browser-compat.js';
import { STORAGE_KEYS } from './constants.js';
import { mergeSettings, mergeSitePrefs, DEFAULTS, originKey } from './settings.js';

const cache = new Map();
const listeners = new Set();

async function readRaw(key) {
  const result = await api.storage.local.get(key);
  return result?.[key];
}

async function writeRaw(key, value) {
  await api.storage.local.set({ [key]: value });
}

/* ---------------------------------------------------------------- settings */

let settingsPromise = null;

export async function getSettings() {
  if (cache.has(STORAGE_KEYS.SETTINGS)) return cache.get(STORAGE_KEYS.SETTINGS);
  if (!settingsPromise) {
    settingsPromise = readRaw(STORAGE_KEYS.SETTINGS)
      .then((stored) => {
        const merged = mergeSettings(stored);
        cache.set(STORAGE_KEYS.SETTINGS, merged);
        return merged;
      })
      .finally(() => {
        settingsPromise = null;
      });
  }
  return settingsPromise;
}

/** Settings without awaiting. Returns defaults until the first load lands. */
export function peekSettings() {
  return cache.get(STORAGE_KEYS.SETTINGS) ?? mergeSettings(null);
}

/**
 * Merge a partial update into settings.
 * `patch` is shaped like the settings object, e.g. `{ downloads: { autoStart: false } }`.
 */
export async function updateSettings(patch) {
  const current = await getSettings();
  const next = mergeSettings(deepMerge(current, patch));
  cache.set(STORAGE_KEYS.SETTINGS, next);
  await writeRaw(STORAGE_KEYS.SETTINGS, next);
  emit('settings', next);
  return next;
}

export async function resetSettings() {
  const fresh = mergeSettings(null);
  cache.set(STORAGE_KEYS.SETTINGS, fresh);
  await writeRaw(STORAGE_KEYS.SETTINGS, fresh);
  emit('settings', fresh);
  return fresh;
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(base?.[key] ?? {}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/* --------------------------------------------------------------- per-site */

export async function getAllSitePrefs() {
  const stored = await readRaw(STORAGE_KEYS.SITE_PREFS);
  return stored && typeof stored === 'object' ? stored : {};
}

export async function getSitePrefs(url) {
  const key = originKey(url);
  if (!key) return mergeSitePrefs(null);
  const all = await getAllSitePrefs();
  return mergeSitePrefs(all[key]);
}

export async function setSitePrefs(url, patch) {
  const key = originKey(url);
  if (!key) return mergeSitePrefs(null);
  const all = await getAllSitePrefs();
  const next = mergeSitePrefs({ ...(all[key] ?? {}), ...patch });
  all[key] = next;
  await writeRaw(STORAGE_KEYS.SITE_PREFS, all);
  emit('sitePrefs', all);
  return next;
}

export async function removeSitePrefs(origin) {
  const all = await getAllSitePrefs();
  delete all[origin];
  await writeRaw(STORAGE_KEYS.SITE_PREFS, all);
  emit('sitePrefs', all);
}

/* ------------------------------------------------------------ generic list */

/** Read an array value, tolerating a corrupted or absent entry. */
export async function readList(key) {
  const stored = await readRaw(key);
  return Array.isArray(stored) ? stored : [];
}

export async function writeList(key, list) {
  await writeRaw(key, Array.isArray(list) ? list : []);
}

/* -------------------------------------------------------------- listeners */

export function onChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(scope, value) {
  for (const listener of listeners) {
    try {
      listener(scope, value);
    } catch {
      // A listener throwing must not stop the others.
    }
  }
}

// Storage can be changed by another extension context (the options page while
// the popup is open, say). Drop the cache so the next read is authoritative.
api.storage?.onChanged?.addListener((changes, area) => {
  if (area !== 'local') return;
  if (STORAGE_KEYS.SETTINGS in changes) {
    const next = mergeSettings(changes[STORAGE_KEYS.SETTINGS].newValue);
    cache.set(STORAGE_KEYS.SETTINGS, next);
    emit('settings', next);
  }
  if (STORAGE_KEYS.SITE_PREFS in changes) {
    emit('sitePrefs', changes[STORAGE_KEYS.SITE_PREFS].newValue ?? {});
  }
});

export { DEFAULTS };
