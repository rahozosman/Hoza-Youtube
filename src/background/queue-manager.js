/**
 * Queue manager.
 *
 * Owns the job list: ordering, concurrency, state transitions, persistence and
 * recovery. It decides *what* runs and *when*; `download-manager.js` moves the
 * bytes.
 *
 * Jobs are persisted so a service-worker restart — which Chromium does freely —
 * does not lose the queue. Native downloads keep running through a restart and
 * are re-attached; an in-flight segment assembly cannot survive one, so it is
 * surfaced as a retryable failure rather than silently dropped.
 */

import { api, sendMessageQuiet } from '../core/browser-compat.js';
import {
  MSG,
  JobState,
  ACTIVE_STATES,
  Delivery,
  STORAGE_KEYS,
} from '../core/constants.js';
import { MediaError, ErrorCode, toRecord, isRetryable } from '../core/errors.js';
import { readList, writeList, getSettings } from '../core/storage.js';
import { fingerprint } from '../core/dedupe.js';
import { buildFilename, nextAvailableName } from '../core/filename.js';
import { primaryLabel } from '../core/quality-resolver.js';
import {
  startTransport,
  reattachTransport,
  isActive,
} from './download-manager.js';
import * as history from './history.js';
import { notifyComplete, notifyFailure } from './notifications.js';

/** id -> job */
const jobs = new Map();
/** id -> transport handle */
const handles = new Map();

let orderCounter = 0;
let restored = false;
let persistTimer = null;
let globallyPaused = false;

/* ------------------------------------------------------------ persistence */

function schedulePersist() {
  if (persistTimer != null) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persist();
  }, 300);
}

async function persist() {
  // Only jobs still in play are worth keeping; finished ones live in history.
  const snapshot = [...jobs.values()]
    .filter((job) => ACTIVE_STATES.has(job.state) || job.state === JobState.FAILED)
    .map((job) => ({ ...job, speed: null, eta: null }));
  await writeList(STORAGE_KEYS.JOBS, snapshot);
}

function broadcast() {
  schedulePersist();
  void sendMessageQuiet({ type: MSG.JOBS_CHANGED, jobs: list() });
}

/* ------------------------------------------------------------------ shape */

function makeJob({ media, stream, filename, settings }) {
  orderCounter += 1;
  const url =
    stream.delivery === Delivery.PROGRESSIVE ? stream.url : (stream.sourceRef?.playlistUrl ?? stream.url);

  return {
    id: `j${Date.now().toString(36)}${orderCounter.toString(36)}`,
    mediaId: media?.id ?? null,
    tabId: media?.tabId ?? null,
    title: media?.title || media?.pageTitle || 'Media',
    pageUrl: media?.pageUrl ?? null,
    pageTitle: media?.pageTitle ?? null,
    url,
    fingerprint: fingerprint(url),
    stream,
    delivery: stream.delivery,
    container: stream.container,
    streamType: stream.type,
    qualityLabel: primaryLabel(stream),
    filename,
    state: JobState.QUEUED,
    bytesReceived: 0,
    totalBytes: stream.size ?? null,
    sizeEstimated: !!stream.sizeEstimated,
    speed: null,
    eta: null,
    note: null,
    error: null,
    retries: 0,
    retryLimit: settings?.downloads?.retryLimit ?? 2,
    chromeDownloadId: null,
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
    order: orderCounter,
  };
}

/**
 * Build a job without enqueuing it, so duplicate detection can run against a
 * fully-formed candidate — filename included.
 */
export async function prepareJob({ media, stream, filenameOverride = null }) {
  const settings = await getSettings();
  const existing = new Set(
    [...jobs.values()].map((job) => String(job.filename).toLowerCase()),
  );
  const completedNames = (await history.completed()).map((entry) =>
    String(entry.filename ?? '').toLowerCase(),
  );
  for (const name of completedNames) existing.add(name);

  const base =
    filenameOverride ??
    buildFilename({
      template: settings.downloads.filenameTemplate,
      stream,
      media,
      subfolder: settings.downloads.subfolder,
    });

  return { job: makeJob({ media, stream, filename: base, settings }), settings, taken: existing };
}

/* ---------------------------------------------------------------- lifecycle */

/**
 * Add a job to the queue.
 * `conflict` is 'rename' | 'replace' | undefined; 'rename' picks a free name.
 */
export async function enqueue({ media, stream, filenameOverride = null, conflict = null }) {
  const { job, settings, taken } = await prepareJob({ media, stream, filenameOverride });

  if (conflict === 'rename') {
    job.filename = nextAvailableName(job.filename, taken);
  }
  job.conflictAction = conflict === 'replace' ? 'overwrite' : 'uniquify';
  job.saveAs = settings.downloads.askForLocation;
  job.segmentConcurrency = settings.downloads.segmentConcurrency;

  jobs.set(job.id, job);

  if (!settings.downloads.autoStart) {
    job.state = JobState.PAUSED;
    job.note = 'Waiting to be started';
  }

  broadcast();
  pump();
  return job;
}

/** Start as many queued jobs as the concurrency limit allows. */
export function pump() {
  void (async () => {
    if (globallyPaused) return;
    const settings = await getSettings();
    const limit = settings.downloads.maxConcurrent;

    const running = [...jobs.values()].filter(
      (job) => job.state === JobState.DOWNLOADING || job.state === JobState.PREPARING,
    ).length;

    if (running >= limit) return;

    const queued = [...jobs.values()]
      .filter((job) => job.state === JobState.QUEUED)
      .sort((a, b) => a.order - b.order);

    for (const job of queued.slice(0, limit - running)) {
      begin(job, settings);
    }
  })();
}

function begin(job, settings) {
  job.state = JobState.PREPARING;
  job.startedAt = job.startedAt ?? Date.now();
  job.error = null;
  broadcast();

  const handle = startTransport(
    job,
    {
      onStarted: ({ downloadId }) => {
        job.chromeDownloadId = downloadId ?? null;
        job.state = JobState.DOWNLOADING;
        job.note = null;
        broadcast();
      },
      onStateNote: (note) => {
        job.note = note;
        broadcast();
      },
      onProgress: ({ bytesReceived, totalBytes, speed, eta, completedSegments, totalSegments }) => {
        job.bytesReceived = bytesReceived ?? job.bytesReceived;
        if (Number.isFinite(totalBytes) && totalBytes > 0) {
          job.totalBytes = totalBytes;
          job.sizeEstimated = job.delivery !== Delivery.PROGRESSIVE && !completedSegments;
        }
        job.speed = speed ?? null;
        job.eta = eta ?? null;
        if (totalSegments) {
          job.note = `Segment ${completedSegments} of ${totalSegments}`;
        }
        if (job.state === JobState.PREPARING) job.state = JobState.DOWNLOADING;
        broadcast();
      },
      onPaused: () => {
        job.state = JobState.PAUSED;
        job.speed = null;
        job.eta = null;
        broadcast();
      },
      onResumed: () => {
        job.state = JobState.DOWNLOADING;
        broadcast();
      },
      onComplete: ({ filename, totalBytes, downloadId }) => {
        job.state = JobState.COMPLETED;
        job.filename = filename ?? job.filename;
        job.totalBytes = totalBytes ?? job.totalBytes;
        job.bytesReceived = job.totalBytes ?? job.bytesReceived;
        job.chromeDownloadId = downloadId ?? job.chromeDownloadId;
        job.sizeEstimated = false;
        job.endedAt = Date.now();
        job.speed = null;
        job.eta = null;
        job.note = null;
        handles.delete(job.id);
        void history.record(job);
        void notifyComplete(job);
        broadcast();
        pump();
      },
      onError: (err) => {
        handles.delete(job.id);
        void fail(job, err);
      },
    },
    {
      conflictAction: job.conflictAction,
      saveAs: job.saveAs,
      segmentConcurrency: job.segmentConcurrency ?? settings.downloads.segmentConcurrency,
    },
  );

  handles.set(job.id, handle);
}

async function fail(job, err) {
  const record = toRecord(err);

  if (record.code === ErrorCode.CANCELLED) {
    job.state = JobState.CANCELLED;
    job.error = record;
    job.endedAt = Date.now();
    job.speed = null;
    job.eta = null;
    broadcast();
    pump();
    return;
  }

  // Automatic retry, bounded, for failures that a retry can plausibly fix.
  if (isRetryable(record.code) && job.retries < job.retryLimit) {
    job.retries += 1;
    job.state = JobState.QUEUED;
    job.note = `Retrying (${job.retries} of ${job.retryLimit})`;
    job.speed = null;
    job.eta = null;
    broadcast();
    setTimeout(() => pump(), 1200 * job.retries);
    return;
  }

  job.state = JobState.FAILED;
  job.error = record;
  job.endedAt = Date.now();
  job.speed = null;
  job.eta = null;
  job.note = null;
  await history.record(job);
  void notifyFailure(job);
  broadcast();
  pump();
}

/* ------------------------------------------------------------------ control */

export async function pause(id) {
  const job = jobs.get(id);
  if (!job) return false;

  if (job.state === JobState.QUEUED) {
    job.state = JobState.PAUSED;
    job.note = 'Waiting to be started';
    broadcast();
    return true;
  }

  const handle = handles.get(id);
  if (!handle) return false;
  const ok = await handle.pause();
  if (!ok) {
    // Some transports cannot pause; say so rather than showing a dead button.
    job.note = 'This source does not support pausing';
    broadcast();
  }
  return ok;
}

export async function resume(id) {
  const job = jobs.get(id);
  if (!job) return false;

  const handle = handles.get(id);
  if (handle) {
    const ok = await handle.resume();
    if (ok) return true;
  }

  job.state = JobState.QUEUED;
  job.note = null;
  broadcast();
  pump();
  return true;
}

export async function cancel(id) {
  const job = jobs.get(id);
  if (!job) return false;

  const handle = handles.get(id);
  if (handle) await handle.cancel();
  handles.delete(id);

  job.state = JobState.CANCELLED;
  job.endedAt = Date.now();
  job.speed = null;
  job.eta = null;
  job.error = { code: ErrorCode.CANCELLED, ...toRecord(new MediaError(ErrorCode.CANCELLED)) };
  await history.record(job);
  broadcast();
  pump();
  return true;
}

export async function retry(id) {
  const job = jobs.get(id) ?? (await rebuildFromHistory(id));
  if (!job) return false;

  job.state = JobState.QUEUED;
  job.error = null;
  job.note = null;
  job.retries = 0;
  job.bytesReceived = 0;
  job.endedAt = null;
  job.chromeDownloadId = null;
  orderCounter += 1;
  job.order = orderCounter;

  jobs.set(job.id, job);
  broadcast();
  pump();
  return true;
}

/** Recreate a job object from a history record, so Failed rows can retry. */
async function rebuildFromHistory(id) {
  const entry = await history.find(id);
  if (!entry?.stream) return null;
  const settings = await getSettings();
  return {
    ...makeJob({
      media: {
        id: null,
        title: entry.title,
        pageUrl: entry.pageUrl,
        pageTitle: entry.pageTitle,
      },
      stream: entry.stream,
      filename: entry.filename,
      settings,
    }),
    id: entry.id,
    filename: entry.filename,
  };
}

export function remove(id) {
  const job = jobs.get(id);
  if (job && ACTIVE_STATES.has(job.state)) return false;
  jobs.delete(id);
  handles.delete(id);
  broadcast();
  return true;
}

export async function pauseAll() {
  globallyPaused = true;
  await Promise.all(
    [...jobs.values()]
      .filter((job) => job.state === JobState.DOWNLOADING || job.state === JobState.QUEUED)
      .map((job) => pause(job.id)),
  );
  broadcast();
}

export async function resumeAll() {
  globallyPaused = false;
  await Promise.all(
    [...jobs.values()]
      .filter((job) => job.state === JobState.PAUSED)
      .map((job) => resume(job.id)),
  );
  broadcast();
  pump();
}

export function isPausedGlobally() {
  return globallyPaused;
}

/** Move a queued job to a new position; only queued jobs can be reordered. */
export function reorder(id, targetIndex) {
  const queued = [...jobs.values()]
    .filter((job) => job.state === JobState.QUEUED || job.state === JobState.PAUSED)
    .sort((a, b) => a.order - b.order);

  const from = queued.findIndex((job) => job.id === id);
  if (from < 0) return false;

  const [moved] = queued.splice(from, 1);
  queued.splice(Math.max(0, Math.min(targetIndex, queued.length)), 0, moved);
  queued.forEach((job, index) => {
    job.order = index + 1;
  });
  orderCounter = Math.max(orderCounter, queued.length);
  broadcast();
  return true;
}

/* -------------------------------------------------------------- accessors */

export function list() {
  return [...jobs.values()].sort((a, b) => {
    const aActive = ACTIVE_STATES.has(a.state) ? 0 : 1;
    const bActive = ACTIVE_STATES.has(b.state) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.order - b.order;
  });
}

export function get(id) {
  return jobs.get(id) ?? null;
}

export function activeCount() {
  return [...jobs.values()].filter((job) => ACTIVE_STATES.has(job.state)).length;
}

/* --------------------------------------------------------------- recovery */

/**
 * Reload the persisted queue after a service-worker restart and reconcile it
 * with what the browser is actually doing.
 */
export async function restore() {
  if (restored) return;
  restored = true;

  const stored = await readList(STORAGE_KEYS.JOBS);
  for (const job of stored) {
    if (!job?.id) continue;
    jobs.set(job.id, job);
    orderCounter = Math.max(orderCounter, job.order ?? 0);
  }

  for (const job of jobs.values()) {
    if (!ACTIVE_STATES.has(job.state)) continue;

    // A native download survives the restart — find out where it got to.
    if (job.chromeDownloadId != null) {
      const [item] = await api.downloads.search({ id: job.chromeDownloadId }).catch(() => []);
      if (item?.state === 'complete') {
        job.state = JobState.COMPLETED;
        job.filename = item.filename || job.filename;
        job.totalBytes = item.totalBytes || job.totalBytes;
        job.bytesReceived = job.totalBytes;
        job.endedAt = Date.now();
        await history.record(job);
        continue;
      }
      if (item?.state === 'in_progress') {
        reattachToNative(job, item);
        continue;
      }
    }

    if (job.delivery === Delivery.PROGRESSIVE) {
      // Requeue: the browser can restart a progressive transfer cleanly.
      job.state = JobState.QUEUED;
      job.note = 'Resuming after the browser restarted';
    } else {
      // An assembly cannot be resumed mid-flight; be honest and offer a retry.
      job.state = JobState.FAILED;
      job.error = toRecord(
        new MediaError(ErrorCode.NETWORK_INTERRUPTED, 'assembly was interrupted by a restart'),
      );
    }
  }

  broadcast();
  pump();
}

function reattachToNative(job, item) {
  job.state = item.paused ? JobState.PAUSED : JobState.DOWNLOADING;
  job.bytesReceived = item.bytesReceived ?? job.bytesReceived;
  job.totalBytes = item.totalBytes > 0 ? item.totalBytes : job.totalBytes;

  const handle = reattachTransport(job, {
    onProgress: ({ bytesReceived, totalBytes, speed, eta }) => {
      job.bytesReceived = bytesReceived ?? job.bytesReceived;
      if (Number.isFinite(totalBytes) && totalBytes > 0) job.totalBytes = totalBytes;
      job.speed = speed ?? null;
      job.eta = eta ?? null;
      broadcast();
    },
    onPaused: () => {
      job.state = JobState.PAUSED;
      broadcast();
    },
    onResumed: () => {
      job.state = JobState.DOWNLOADING;
      broadcast();
    },
    onComplete: ({ filename, totalBytes, downloadId }) => {
      job.state = JobState.COMPLETED;
      job.filename = filename ?? job.filename;
      job.totalBytes = totalBytes ?? job.totalBytes;
      job.bytesReceived = job.totalBytes ?? job.bytesReceived;
      job.chromeDownloadId = downloadId ?? job.chromeDownloadId;
      job.endedAt = Date.now();
      handles.delete(job.id);
      void history.record(job);
      void notifyComplete(job);
      broadcast();
      pump();
    },
    onError: (err) => {
      handles.delete(job.id);
      void fail(job, err);
    },
  });

  handles.set(job.id, handle);
}

export { isActive };
