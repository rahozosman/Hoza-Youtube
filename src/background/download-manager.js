/**
 * Transport layer.
 *
 * Two strategies, chosen by how the source delivers the stream:
 *
 *   progressive — hand the URL to `chrome.downloads`, which gives us the
 *                 browser's own resumable transfer and native pause/resume.
 *   segmented   — fetch and join the segments, then hand the resulting blob
 *                 to `chrome.downloads` so it still lands in the user's
 *                 download folder and history.
 *
 * The queue decides *what* runs; this module only knows how to move bytes.
 */

import { api, features } from '../core/browser-compat.js';
import { Delivery, JobState, PROGRESS_POLL_MS } from '../core/constants.js';
import { MediaError, ErrorCode, fromInterruptReason, toRecord } from '../core/errors.js';
import { buildPlan } from './manifest-probe.js';
import { mimeForContainer } from '../core/assembler.js';
import {
  assembleStream,
  pauseAssembly,
  resumeAssembly,
  abortAssembly,
  releaseAssembled,
} from './offscreen-bridge.js';

/** chrome download id -> internal job id */
const byDownloadId = new Map();
/** job id -> transport record */
const transports = new Map();

let pollTimer = null;

/* ------------------------------------------------------------- speed maths */

function updateRate(record, bytesReceived) {
  const now = Date.now();
  if (record.lastBytes == null) {
    record.lastBytes = bytesReceived;
    record.lastAt = now;
    return record.speed ?? 0;
  }
  const elapsed = (now - record.lastAt) / 1000;
  if (elapsed < 0.25) return record.speed ?? 0;

  const instant = Math.max(0, (bytesReceived - record.lastBytes) / elapsed);
  // Exponential smoothing keeps the readout steady without lagging a stall.
  record.speed = record.speed == null ? instant : record.speed * 0.7 + instant * 0.3;
  record.lastBytes = bytesReceived;
  record.lastAt = now;
  return record.speed;
}

function etaFor(record, bytesReceived, totalBytes) {
  if (!totalBytes || !record.speed || record.speed <= 0) return null;
  const remaining = totalBytes - bytesReceived;
  if (remaining <= 0) return 0;
  return remaining / record.speed;
}

/* ------------------------------------------------------- native downloads */

function startPolling() {
  if (pollTimer != null) return;
  pollTimer = setInterval(pollNative, PROGRESS_POLL_MS);
}

function stopPollingIfIdle() {
  const stillNative = [...transports.values()].some(
    (record) => record.downloadId != null && record.state === JobState.DOWNLOADING,
  );
  if (!stillNative && pollTimer != null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollNative() {
  const active = [...transports.values()].filter(
    (record) => record.downloadId != null && record.state === JobState.DOWNLOADING,
  );
  if (!active.length) {
    stopPollingIfIdle();
    return;
  }

  await Promise.all(
    active.map(async (record) => {
      try {
        const [item] = await api.downloads.search({ id: record.downloadId });
        if (!item) return;
        const bytesReceived = item.bytesReceived ?? 0;
        const totalBytes = item.totalBytes > 0 ? item.totalBytes : (record.expectedBytes ?? null);
        const speed = updateRate(record, bytesReceived);
        record.callbacks.onProgress?.({
          bytesReceived,
          totalBytes,
          speed,
          eta: etaFor(record, bytesReceived, totalBytes),
        });
      } catch {
        // A transient search failure is not worth surfacing.
      }
    }),
  );
}

/** Translate the browser's own download events into job outcomes. */
function handleDownloadChanged(delta) {
  const jobId = byDownloadId.get(delta.id);
  if (!jobId) return;
  const record = transports.get(jobId);
  if (!record) return;

  if (delta.state?.current === 'complete') {
    finishNative(record, delta.id);
    return;
  }

  if (delta.state?.current === 'interrupted') {
    const reason = delta.error?.current ?? 'UNKNOWN';
    // Some builds report a paused transfer as interrupted/USER_CANCELED. Read
    // the state before cleanup touches it, or a pause looks like a failure.
    const wasPaused = record.state === JobState.PAUSED;
    if (reason === 'USER_CANCELED' && wasPaused) return;
    cleanupNative(record, delta.id);
    record.callbacks.onError?.(new MediaError(fromInterruptReason(reason), reason));
    return;
  }

  if (delta.paused?.current === true) {
    record.state = JobState.PAUSED;
    record.callbacks.onPaused?.();
  } else if (delta.paused?.current === false) {
    record.state = JobState.DOWNLOADING;
    record.callbacks.onResumed?.();
    startPolling();
  }
}

async function finishNative(record, downloadId) {
  let filename = record.filename;
  let totalBytes = record.expectedBytes ?? null;
  try {
    const [item] = await api.downloads.search({ id: downloadId });
    if (item) {
      filename = item.filename || filename;
      totalBytes = item.totalBytes > 0 ? item.totalBytes : (item.bytesReceived ?? totalBytes);
    }
  } catch {
    // Fall back to what we already knew.
  }
  cleanupNative(record, downloadId);
  record.callbacks.onComplete?.({ filename, totalBytes, downloadId });
}

function cleanupNative(record, downloadId) {
  byDownloadId.delete(downloadId);
  if (record.blobUrl) {
    releaseAssembled(record.blobUrl);
    record.blobUrl = null;
  }
  transports.delete(record.jobId);
  stopPollingIfIdle();
}

/** Start a browser download and register it against the job. */
async function beginNativeDownload(record, url, { revokeAfter = false } = {}) {
  const options = {
    url,
    filename: record.filename,
    conflictAction: record.conflictAction ?? 'uniquify',
    saveAs: !!record.saveAs,
  };

  let downloadId;
  try {
    downloadId = await api.downloads.download(options);
  } catch (err) {
    const message = String(err?.message ?? err);
    if (/filename/i.test(message)) {
      throw new MediaError(ErrorCode.FILE_NAME_INVALID, message);
    }
    if (/permission/i.test(message)) {
      throw new MediaError(ErrorCode.FILE_PERMISSION, message);
    }
    throw new MediaError(ErrorCode.UNKNOWN, message);
  }

  if (downloadId == null) {
    throw new MediaError(ErrorCode.UNKNOWN, 'the browser refused the download');
  }

  record.downloadId = downloadId;
  record.state = JobState.DOWNLOADING;
  if (revokeAfter) record.blobUrl = url;
  byDownloadId.set(downloadId, record.jobId);
  startPolling();
  record.callbacks.onStarted?.({ downloadId });
}

/* ------------------------------------------------------------- strategies */

async function runProgressive(record, job) {
  record.expectedBytes = job.totalBytes ?? null;
  await beginNativeDownload(record, job.url);
}

async function runSegmented(record, job) {
  record.callbacks.onStateNote?.('Reading stream layout');

  const plan = await buildPlan(job.stream);

  // A DASH representation described by SegmentBase is really one file, so it
  // can take the far cheaper native path after all.
  if (plan.delivery === Delivery.PROGRESSIVE) {
    record.expectedBytes = job.totalBytes ?? null;
    await beginNativeDownload(record, plan.url);
    return;
  }

  if (record.cancelled) throw new MediaError(ErrorCode.CANCELLED, 'cancelled before assembly');

  record.assembling = true;
  record.callbacks.onStateNote?.(`Joining ${plan.segments.length} segments`);

  const { url, size } = await assembleStream(
    {
      jobId: job.id,
      segments: plan.segments,
      initSegment: plan.initSegment,
      mimeType: mimeForContainer(job.container),
      concurrency: record.segmentConcurrency ?? 4,
      expectedBytes: job.totalBytes ?? null,
    },
    (progress) => {
      const speed = updateRate(record, progress.bytesReceived);
      record.callbacks.onProgress?.({
        bytesReceived: progress.bytesReceived,
        totalBytes: progress.totalBytes,
        speed,
        eta: etaFor(record, progress.bytesReceived, progress.totalBytes),
        completedSegments: progress.completedSegments,
        totalSegments: progress.totalSegments,
      });
    },
  );

  record.assembling = false;
  if (record.cancelled) {
    await releaseAssembled(url);
    throw new MediaError(ErrorCode.CANCELLED, 'cancelled during assembly');
  }

  record.expectedBytes = size;
  // Writing a blob to disk is effectively instant; report it as complete data.
  record.callbacks.onProgress?.({
    bytesReceived: size,
    totalBytes: size,
    speed: record.speed ?? 0,
    eta: 0,
  });

  await beginNativeDownload(record, url, { revokeAfter: true });
}

/* -------------------------------------------------------------------- API */

/**
 * Begin transferring a job.
 *
 * `callbacks` receives `onStarted`, `onProgress`, `onComplete`, `onError`,
 * `onPaused`, `onResumed` and `onStateNote`. Returns a handle for control.
 */
export function startTransport(job, callbacks, options = {}) {
  const record = {
    jobId: job.id,
    filename: job.filename,
    conflictAction: options.conflictAction ?? 'uniquify',
    saveAs: options.saveAs ?? false,
    segmentConcurrency: options.segmentConcurrency ?? 4,
    callbacks,
    downloadId: null,
    blobUrl: null,
    state: JobState.PREPARING,
    cancelled: false,
    assembling: false,
    speed: null,
    lastBytes: null,
    lastAt: null,
    expectedBytes: job.totalBytes ?? null,
  };
  transports.set(job.id, record);

  const run = job.delivery === Delivery.PROGRESSIVE ? runProgressive : runSegmented;

  run(record, job).catch((err) => {
    transports.delete(job.id);
    stopPollingIfIdle();
    if (record.cancelled) {
      callbacks.onError?.(new MediaError(ErrorCode.CANCELLED, 'cancelled'));
      return;
    }
    callbacks.onError?.(err);
  });

  return makeHandle(job.id);
}

/**
 * Re-attach to a native download that is still running after a service-worker
 * restart. The browser kept transferring; we only lost our listener.
 */
export function reattachTransport(job, callbacks) {
  const record = {
    jobId: job.id,
    filename: job.filename,
    conflictAction: 'uniquify',
    saveAs: false,
    callbacks,
    downloadId: job.chromeDownloadId,
    blobUrl: null,
    state: JobState.DOWNLOADING,
    cancelled: false,
    assembling: false,
    speed: null,
    lastBytes: null,
    lastAt: null,
    expectedBytes: job.totalBytes ?? null,
  };

  transports.set(job.id, record);
  byDownloadId.set(job.chromeDownloadId, job.id);
  startPolling();
  return makeHandle(job.id);
}

function makeHandle(jobId) {
  return {
    async pause() {
      const record = transports.get(jobId);
      if (!record) return false;
      if (record.assembling) {
        await pauseAssembly(jobId);
        record.state = JobState.PAUSED;
        record.callbacks.onPaused?.();
        return true;
      }
      if (record.downloadId != null && features.pausableDownloads) {
        record.state = JobState.PAUSED;
        try {
          await api.downloads.pause(record.downloadId);
          record.callbacks.onPaused?.();
          return true;
        } catch {
          record.state = JobState.DOWNLOADING;
          return false;
        }
      }
      return false;
    },

    async resume() {
      const record = transports.get(jobId);
      if (!record) return false;
      if (record.assembling) {
        await resumeAssembly(jobId);
        record.state = JobState.DOWNLOADING;
        record.callbacks.onResumed?.();
        return true;
      }
      if (record.downloadId != null) {
        try {
          await api.downloads.resume(record.downloadId);
          record.state = JobState.DOWNLOADING;
          record.callbacks.onResumed?.();
          startPolling();
          return true;
        } catch {
          return false;
        }
      }
      return false;
    },

    async cancel() {
      const record = transports.get(jobId);
      if (!record) return false;
      record.cancelled = true;

      if (record.assembling) await abortAssembly(jobId);

      if (record.downloadId != null) {
        try {
          await api.downloads.cancel(record.downloadId);
        } catch {
          // Already finished or gone.
        }
        byDownloadId.delete(record.downloadId);
      }

      if (record.blobUrl) {
        await releaseAssembled(record.blobUrl);
        record.blobUrl = null;
      }

      transports.delete(jobId);
      stopPollingIfIdle();
      return true;
    },
  };
}

/** True while the transport for a job is still live. */
export function isActive(jobId) {
  return transports.has(jobId);
}

export function activeAssemblyCount() {
  return [...transports.values()].filter((record) => record.assembling).length;
}

/** Ask the browser to reveal a completed file in the OS file manager. */
export async function revealFile(downloadId) {
  try {
    await api.downloads.show(downloadId);
    return true;
  } catch {
    return false;
  }
}

/** Ask the browser to open a completed file with the system default app. */
export async function openFile(downloadId) {
  try {
    await api.downloads.open(downloadId);
    return true;
  } catch (err) {
    return toRecord(err);
  }
}

/** Register the download listener. Called once per service worker start. */
export function attachDownloadListeners() {
  if (!api.downloads?.onChanged) return;
  api.downloads.onChanged.addListener(handleDownloadChanged);
}
