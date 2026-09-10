/**
 * Duplicate detection.
 *
 * Before a download starts we check three things, in decreasing confidence:
 *   1. the exact target filename, against completed history
 *   2. the normalised media URL, against completed history
 *   3. the same URL already sitting in the active queue
 *
 * Signed media URLs carry expiry and token parameters that change on every
 * page load, so those are stripped before comparison; otherwise the same file
 * would never look like a duplicate of itself.
 */

import { ACTIVE_STATES } from './constants.js';

/** Query parameters that vary per request and say nothing about identity. */
const VOLATILE_PARAMS = [
  /^(x-)?(amz|goog|ms)-/i,
  /^(expires?|expiry|exp|e)$/i,
  /^(signature|sig|sign|hmac|token|key|auth|policy)$/i,
  /^(session|sid|cid|uid|rid|nonce|ts|timestamp|_t|cb|cachebust)$/i,
  /^(range|rn|rbuf|ei|ip|ipbits|mt|mv|ms|mm|pl|lmt)$/i,
];

function isVolatile(name) {
  return VOLATILE_PARAMS.some((pattern) => pattern.test(name));
}

/**
 * A stable identity for a media URL: origin plus path plus the query
 * parameters that actually select content, sorted for order-independence.
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    const kept = [];
    for (const [name, value] of parsed.searchParams.entries()) {
      if (!isVolatile(name)) kept.push([name, value]);
    }
    kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
    const query = kept.map(([name, value]) => `${name}=${value}`).join('&');
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${path}${query ? `?${query}` : ''}`.toLowerCase();
  } catch {
    return String(url ?? '').toLowerCase();
  }
}

/** Cheap non-cryptographic hash, used only as a storage key. */
export function fingerprint(url) {
  const text = normalizeUrl(url);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(36)}${h2.toString(36)}`;
}

/**
 * Look for a duplicate of `candidate` among history records and active jobs.
 *
 * Returns null when there is none, otherwise
 * `{ reason, match }` where reason is 'filename' | 'url' | 'queued'.
 */
export function findDuplicate(candidate, { history = [], jobs = [] } = {}) {
  const targetName = String(candidate.filename ?? '').toLowerCase();
  const targetUrl = normalizeUrl(candidate.url);

  const queued = jobs.find(
    (job) => ACTIVE_STATES.has(job.state) && normalizeUrl(job.url) === targetUrl,
  );
  if (queued) return { reason: 'queued', match: queued };

  const completed = history.filter((entry) => entry.state === 'completed');

  const byName = completed.find((entry) => String(entry.filename ?? '').toLowerCase() === targetName);
  if (byName) return { reason: 'filename', match: byName };

  const byUrl = completed.find((entry) => entry.fingerprint === candidate.fingerprint);
  if (byUrl) return { reason: 'url', match: byUrl };

  return null;
}

/** Sentence explaining a duplicate, shown in the prompt. */
export function describeDuplicate(result) {
  if (!result) return '';
  switch (result.reason) {
    case 'queued':
      return 'This exact media is already in the download queue.';
    case 'filename':
      return 'A file with this name was already saved.';
    case 'url':
      return 'You already downloaded this media, under a different name.';
    default:
      return 'This looks like something you already have.';
  }
}
