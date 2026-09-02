/**
 * Network observation.
 *
 * Watches media responses so that streams delivered through MSE — which never
 * appear as a `src` in the DOM — can still be offered. This runs only on
 * origins the user has explicitly granted, because `webRequest` listeners are
 * scoped to host permissions and Hoza YT asks for none at install time.
 *
 * The observer is read-only. It never blocks, redirects or rewrites a request.
 */

import { api } from '../core/browser-compat.js';
import { addItem, looksLikeSegment, kindOf } from './media-registry.js';
import { peekSettings } from '../core/storage.js';
import { originKey } from '../core/settings.js';
import { Delivery } from '../core/constants.js';
import { isManifestUrl, isMediaUrl } from '../core/format-utils.js';

const WATCHED_TYPES = ['media', 'xmlhttprequest', 'other'];

/** Content types that indicate a whole media file or a manifest. */
const MEDIA_TYPE_PATTERN =
  /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml|octet-stream))/i;

let disabledOrigins = new Set();
let onDetected = null;

function headerValue(headers, name) {
  if (!Array.isArray(headers)) return null;
  const target = name.toLowerCase();
  for (const header of headers) {
    if (header?.name?.toLowerCase() === target) return header.value ?? null;
  }
  return null;
}

/**
 * Decide whether a response is worth registering.
 * Returns the media item input, or null to ignore it.
 */
export function classifyResponse({ url, tabId, statusCode, responseHeaders, type }) {
  if (tabId == null || tabId < 0) return null;
  if (statusCode != null && (statusCode < 200 || statusCode >= 300)) return null;

  const contentType = headerValue(responseHeaders, 'content-type');
  const lengthHeader = headerValue(responseHeaders, 'content-length');
  const contentLength = lengthHeader != null ? Number(lengthHeader) : null;

  const manifest = isManifestUrl(url);
  const declaredMedia = contentType ? MEDIA_TYPE_PATTERN.test(contentType) : false;
  const namedMedia = isMediaUrl(url);

  if (!manifest && !declaredMedia && !namedMedia) return null;

  // A partial response is a range request against a larger file; the file
  // itself will have been seen, or will be, as a complete response.
  if (statusCode === 206 && !manifest) return null;

  if (!manifest && looksLikeSegment(url, contentLength)) return null;

  // `octet-stream` is only interesting when the URL names a media file.
  if (
    !manifest &&
    !namedMedia &&
    /octet-stream/i.test(contentType ?? '') &&
    !(Number.isFinite(contentLength) && contentLength > 0)
  ) {
    return null;
  }

  const kind = kindOf(url, contentType);
  return {
    url,
    kind,
    contentType,
    contentLength: Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null,
    source: 'network',
    requestType: type ?? null,
  };
}

function handleResponse(details) {
  try {
    const settings = peekSettings();
    if (!settings.detection.enabled || !settings.detection.watchNetwork) return;

    const origin = originKey(details.initiator ?? details.documentUrl ?? details.url);
    if (origin && disabledOrigins.has(origin)) return;

    const input = classifyResponse(details);
    if (!input) return;

    const item = addItem(details.tabId, input);
    if (item) onDetected?.(details.tabId, item);
  } catch {
    // Detection must never break page loading; a bad response is simply skipped.
  }
}

let registered = false;

/**
 * Attach the listener. Safe to call repeatedly — the service worker restarts
 * often, and listeners must be re-registered on every start.
 */
export function startNetworkObserver({ onMedia } = {}) {
  onDetected = onMedia ?? null;
  if (registered || !api.webRequest?.onHeadersReceived) return;

  api.webRequest.onHeadersReceived.addListener(
    handleResponse,
    { urls: ['http://*/*', 'https://*/*'], types: WATCHED_TYPES },
    ['responseHeaders'],
  );

  registered = true;
}

/** Origins the user switched detection off for. */
export function setDisabledOrigins(origins) {
  disabledOrigins = new Set(origins ?? []);
}

export { Delivery };
