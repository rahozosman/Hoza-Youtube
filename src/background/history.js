/**
 * Download history.
 *
 * Records what was saved so the manager can show it, retries can re-run it and
 * duplicate detection can recognise it. Stores the media URL because a redownload
 * needs it; nothing about pages that were merely visited is ever written.
 */

import { readList, writeList, getSettings } from '../core/storage.js';
import { STORAGE_KEYS, HISTORY_LIMIT } from '../core/constants.js';

let cache = null;
let writeChain = Promise.resolve();

async function load() {
  if (cache) return cache;
  cache = await readList(STORAGE_KEYS.HISTORY);
  return cache;
}

/** Serialise writes so two concurrent completions cannot clobber each other. */
function enqueueWrite() {
  writeChain = writeChain
    .then(() => writeList(STORAGE_KEYS.HISTORY, cache ?? []))
    .catch(() => {});
  return writeChain;
}

export async function all() {
  return [...(await load())];
}

/** Completed entries, newest first. */
export async function completed() {
  return (await all()).filter((entry) => entry.state === 'completed');
}

/** Failed and cancelled entries, newest first. */
export async function failed() {
  return (await all()).filter((entry) => entry.state === 'failed' || entry.state === 'cancelled');
}

/**
 * Append a record. Trims to the configured limit, oldest first.
 * A job that is recorded twice (a retry, say) replaces its earlier record.
 */
export async function record(job) {
  const settings = await getSettings();
  if (!settings.advanced.keepHistory) return;

  const list = await load();
  const entry = {
    id: job.id,
    title: job.title,
    filename: job.filename,
    url: job.url,
    fingerprint: job.fingerprint,
    state: job.state,
    container: job.container,
    quality: job.qualityLabel,
    streamType: job.streamType,
    totalBytes: job.totalBytes ?? null,
    bytesReceived: job.bytesReceived ?? null,
    pageUrl: job.pageUrl ?? null,
    pageTitle: job.pageTitle ?? null,
    chromeDownloadId: job.chromeDownloadId ?? null,
    error: job.error ?? null,
    finishedAt: Date.now(),
    // Kept so a retry can rebuild the job without re-detecting the page.
    stream: job.stream ?? null,
  };

  const existing = list.findIndex((item) => item.id === job.id);
  if (existing >= 0) list.splice(existing, 1);

  list.unshift(entry);

  const limit = Math.min(settings.advanced.historyLimit || HISTORY_LIMIT, HISTORY_LIMIT * 10);
  if (list.length > limit) list.length = limit;

  await enqueueWrite();
  return entry;
}

export async function remove(id) {
  const list = await load();
  const index = list.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  list.splice(index, 1);
  await enqueueWrite();
  return true;
}

export async function clear(scope = 'all') {
  const list = await load();
  const kept =
    scope === 'completed'
      ? list.filter((entry) => entry.state !== 'completed')
      : scope === 'failed'
        ? list.filter((entry) => entry.state === 'completed')
        : [];
  cache = kept;
  await enqueueWrite();
  return kept.length;
}

export async function find(id) {
  return (await load()).find((entry) => entry.id === id) ?? null;
}
