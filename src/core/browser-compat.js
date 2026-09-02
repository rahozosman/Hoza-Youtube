/**
 * Browser compatibility layer.
 *
 * Chrome/Edge expose `chrome`; Firefox exposes both `browser` (promise-based)
 * and a partial `chrome`. We prefer `browser` where it exists so that Firefox
 * gets native promises, and fall back to `chrome`, whose MV3 APIs are also
 * promise-based in Chrome 116+.
 */

/* global browser */
const root = (typeof globalThis !== 'undefined' && globalThis) || self;

export const api =
  typeof browser !== 'undefined' && browser?.runtime ? browser : root.chrome;

export const runtime = api.runtime;

/** Feature probes — never branch on user-agent strings. */
export const features = {
  /** chrome.offscreen exists only in Chromium MV3. */
  offscreen: typeof api.offscreen !== 'undefined',
  /** Firefox event pages have DOM access; Chromium service workers do not. */
  domInBackground: typeof root.document !== 'undefined',
  /** MAIN-world declarative content scripts (Chrome 111+). */
  mainWorldScripts: (() => {
    try {
      return Object.values(api.scripting?.ExecutionWorld ?? {}).includes('MAIN');
    } catch {
      return false;
    }
  })(),
  /** chrome.downloads.pause/resume. */
  pausableDownloads: typeof api.downloads?.pause === 'function',
  notifications: typeof api.notifications !== 'undefined',
};

export const isGecko = typeof browser !== 'undefined' && !!browser.runtime?.getBrowserInfo;

/**
 * `chrome.runtime.sendMessage` rejects when no receiver is listening (e.g. the
 * popup closed mid-flight). That is routine, not an error worth surfacing.
 */
export async function sendMessageQuiet(message) {
  try {
    return await runtime.sendMessage(message);
  } catch {
    return undefined;
  }
}

/** Same, for a message aimed at a content script in a specific tab. */
export async function sendTabMessageQuiet(tabId, message) {
  try {
    return await api.tabs.sendMessage(tabId, message);
  } catch {
    return undefined;
  }
}

/** Resolve an extension-relative path to a full URL. */
export const asset = (path) => runtime.getURL(path);
