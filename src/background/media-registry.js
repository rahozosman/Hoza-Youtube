/**
 * Per-tab registry of detected media.
 *
 * Deliberately in-memory only: what a user has open is not something this
 * extension writes to disk. Everything here is dropped when the tab navigates
 * away or closes.
 */

import { api } from '../core/browser-compat.js';
import { normalizeUrl } from '../core/dedupe.js';
import { containerOf, isManifestUrl, extensionOf } from '../core/format-utils.js';
import { Delivery, MIN_PROGRESSIVE_BYTES, SEGMENT_EXTENSIONS } from '../core/constants.js';

/** tabId -> { pageInfo, items: Map<key, MediaItem>, protectedReason } */
const tabs = new Map();

let sequence = 0;
const nextId = () => `m${Date.now().toString(36)}${(sequence += 1).toString(36)}`;

function tabState(tabId) {
  let state = tabs.get(tabId);
  if (!state) {
    state = { pageInfo: null, items: new Map(), protectedReason: null };
    tabs.set(tabId, state);
  }
  return state;
}

/** Classify a URL into a delivery kind. */
export function kindOf(url, contentType) {
  const ext = extensionOf(url);
  if (ext === 'm3u8' || ext === 'm3u') return Delivery.HLS;
  if (ext === 'mpd') return Delivery.DASH;
  const type = String(contentType ?? '').toLowerCase();
  if (type.includes('mpegurl')) return Delivery.HLS;
  if (type.includes('dash+xml')) return Delivery.DASH;
  return Delivery.PROGRESSIVE;
}

/**
 * Reject responses that are individual segments rather than a whole file.
 * A .ts or .m4s is only meaningful through its manifest, and a small media
 * response is almost always a fragment.
 */
export function looksLikeSegment(url, contentLength) {
  const ext = extensionOf(url);
  if (ext && SEGMENT_EXTENSIONS.has(ext)) return true;
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength < MIN_PROGRESSIVE_BYTES) {
    return true;
  }
  return false;
}

export function setPageInfo(tabId, pageInfo) {
  const state = tabState(tabId);
  state.pageInfo = { ...(state.pageInfo ?? {}), ...pageInfo };
  return state.pageInfo;
}

export function getPageInfo(tabId) {
  return tabs.get(tabId)?.pageInfo ?? null;
}

/** Record that the page uses content protection, so the UI can say so. */
export function markProtected(tabId, reason) {
  tabState(tabId).protectedReason = reason ?? 'encrypted';
}

export function getProtectedReason(tabId) {
  return tabs.get(tabId)?.protectedReason ?? null;
}

/**
 * Add or merge a media item. Keyed on the normalised URL so the same media
 * seen by both the DOM scan and the network observer becomes one entry, with
 * whichever source supplied the richer metadata winning.
 */
export function addItem(tabId, input) {
  if (!input?.url) return null;
  const state = tabState(tabId);
  const key = normalizeUrl(input.url);

  const existing = state.items.get(key);
  if (existing) {
    const merged = mergeItem(existing, input);
    state.items.set(key, merged);
    return merged;
  }

  const item = {
    id: nextId(),
    tabId,
    url: input.url,
    key,
    kind: input.kind ?? kindOf(input.url, input.contentType),
    container: input.container ?? containerOf(input.url, input.contentType),
    contentType: input.contentType ?? null,
    contentLength: Number.isFinite(input.contentLength) ? input.contentLength : null,
    title: input.title ?? null,
    thumbnail: input.thumbnail ?? null,
    duration: Number.isFinite(input.duration) ? input.duration : null,
    width: input.width ?? null,
    height: input.height ?? null,
    pageUrl: input.pageUrl ?? state.pageInfo?.url ?? null,
    pageTitle: input.pageTitle ?? state.pageInfo?.title ?? null,
    source: input.source ?? 'network',
    protected: !!input.protected,
    protectedReason: input.protectedReason ?? null,
    analyzed: false,
    analyzing: false,
    streams: [],
    error: null,
    firstSeen: Date.now(),
  };

  state.items.set(key, item);
  return item;
}

/** Later information supplements earlier information; it never blanks it out. */
function mergeItem(existing, input) {
  const merged = { ...existing };
  const prefer = (key, value) => {
    if (value == null || value === '') return;
    if (merged[key] == null || merged[key] === '') merged[key] = value;
  };

  prefer('title', input.title);
  prefer('thumbnail', input.thumbnail);
  prefer('contentType', input.contentType);
  prefer('container', input.container);
  prefer('pageUrl', input.pageUrl);
  prefer('pageTitle', input.pageTitle);
  prefer('width', input.width);
  prefer('height', input.height);

  if (Number.isFinite(input.duration) && !Number.isFinite(merged.duration)) {
    merged.duration = input.duration;
  }
  if (Number.isFinite(input.contentLength) && !Number.isFinite(merged.contentLength)) {
    merged.contentLength = input.contentLength;
  }
  // A DOM sighting is stronger evidence than a network sighting, because it
  // carries the title and poster the page itself shows.
  if (input.source === 'dom') merged.source = 'dom';
  if (input.protected) {
    merged.protected = true;
    merged.protectedReason = input.protectedReason ?? merged.protectedReason;
  }
  return merged;
}

/** Replace an item wholesale, used after analysis fills in the stream list. */
export function updateItem(tabId, itemId, patch) {
  const state = tabs.get(tabId);
  if (!state) return null;
  for (const [key, item] of state.items) {
    if (item.id === itemId) {
      const next = { ...item, ...patch };
      state.items.set(key, next);
      return next;
    }
  }
  return null;
}

export function getItem(tabId, itemId) {
  const state = tabs.get(tabId);
  if (!state) return null;
  for (const item of state.items.values()) {
    if (item.id === itemId) return item;
  }
  return null;
}

/** Every item for a tab, newest metadata first, best candidates first. */
export function listItems(tabId) {
  const state = tabs.get(tabId);
  if (!state) return [];
  return [...state.items.values()].sort((a, b) => {
    // Items the page itself displayed rank above ones only seen on the wire.
    if (a.source !== b.source) return a.source === 'dom' ? -1 : 1;
    // Then manifests, which describe several qualities, above single files.
    const aManifest = isManifestUrl(a.url) ? 0 : 1;
    const bManifest = isManifestUrl(b.url) ? 0 : 1;
    if (aManifest !== bManifest) return aManifest - bManifest;
    return a.firstSeen - b.firstSeen;
  });
}

export function clearTab(tabId) {
  tabs.delete(tabId);
}

/** Drop detected media but keep the page identity, used on same-tab navigation. */
export function resetForNavigation(tabId, pageInfo) {
  const state = tabState(tabId);
  state.items.clear();
  state.protectedReason = null;
  state.pageInfo = pageInfo ?? null;
}

export function tabCount(tabId) {
  return tabs.get(tabId)?.items.size ?? 0;
}

/** Serialisable snapshot for the UI, without the internal key field. */
export function snapshot(tabId) {
  const state = tabs.get(tabId);
  return {
    pageInfo: state?.pageInfo ?? null,
    protectedReason: state?.protectedReason ?? null,
    items: listItems(tabId).map(({ key, ...rest }) => rest),
  };
}

// Housekeeping: a closed or navigated tab must not leak its media list.
api.tabs?.onRemoved?.addListener((tabId) => clearTab(tabId));

api.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  // `loading` with a url change means a real navigation, not just a title update.
  if (changeInfo.status === 'loading' && changeInfo.url) {
    resetForNavigation(tabId, { url: changeInfo.url, title: null });
  }
});
