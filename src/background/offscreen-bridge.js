/**
 * Offscreen document bridge.
 *
 * Chromium service workers have no `Blob` URL support, so assembled segment
 * streams are joined inside an offscreen document and handed back as a blob
 * URL. Firefox event pages have DOM access, so there the assembler runs
 * inline and no offscreen document is created.
 */

import { api, features } from '../core/browser-compat.js';
import { MSG } from '../core/constants.js';
import { MediaError, ErrorCode } from '../core/errors.js';

const OFFSCREEN_PATH = 'src/offscreen/offscreen.html';

let creating = null;

async function hasDocument() {
  if (typeof api.offscreen?.hasDocument === 'function') {
    return api.offscreen.hasDocument();
  }
  // Older builds: look for our page among the extension's active contexts.
  const contexts = await api.runtime.getContexts?.({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return Array.isArray(contexts) && contexts.length > 0;
}

/** Create the offscreen document once, tolerating concurrent callers. */
async function ensureDocument() {
  if (await hasDocument()) return;
  if (creating) {
    await creating;
    return;
  }
  creating = api.offscreen
    .createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['BLOBS'],
      justification:
        'Join downloaded media segments into a single file and expose it as a blob URL.',
    })
    .catch((err) => {
      // A racing creation call is not a failure.
      if (!/single offscreen/i.test(String(err?.message ?? ''))) throw err;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

/* --------------------------------------------------------- inline fallback */

const inlineHandles = new Map();

async function assembleInline(request, onProgress) {
  const { assemble } = await import('../core/assembler.js');
  const handle = assemble({
    segments: request.segments,
    initSegment: request.initSegment,
    mimeType: request.mimeType,
    concurrency: request.concurrency,
    expectedBytes: request.expectedBytes,
    onProgress,
  });
  inlineHandles.set(request.jobId, handle);
  try {
    const blob = await handle.promise;
    const url = URL.createObjectURL(blob);
    return { url, size: blob.size };
  } finally {
    inlineHandles.delete(request.jobId);
  }
}

/* -------------------------------------------------------------------- API */

const progressListeners = new Map();

/**
 * Assemble a segmented stream and resolve to `{ url, size }`, where `url` is a
 * blob URL owned by whichever context did the work. Call `releaseAssembled`
 * once the download has finished with it.
 */
export async function assembleStream(request, onProgress) {
  if (onProgress) progressListeners.set(request.jobId, onProgress);
  try {
    if (!features.offscreen) {
      return await assembleInline(request, onProgress);
    }

    await ensureDocument();
    const response = await api.runtime.sendMessage({
      type: MSG.OFFSCREEN_ASSEMBLE,
      target: 'offscreen',
      ...request,
    });

    if (!response) {
      throw new MediaError(ErrorCode.UNKNOWN, 'offscreen document did not respond');
    }
    if (response.error) {
      throw new MediaError(response.error.code ?? ErrorCode.UNKNOWN, response.error.detail);
    }
    return { url: response.url, size: response.size };
  } finally {
    progressListeners.delete(request.jobId);
  }
}

export async function pauseAssembly(jobId) {
  if (!features.offscreen) {
    inlineHandles.get(jobId)?.pause();
    return;
  }
  await api.runtime
    .sendMessage({ type: MSG.OFFSCREEN_PAUSE, target: 'offscreen', jobId })
    .catch(() => {});
}

export async function resumeAssembly(jobId) {
  if (!features.offscreen) {
    inlineHandles.get(jobId)?.resume();
    return;
  }
  await api.runtime
    .sendMessage({ type: MSG.OFFSCREEN_RESUME, target: 'offscreen', jobId })
    .catch(() => {});
}

export async function abortAssembly(jobId) {
  if (!features.offscreen) {
    inlineHandles.get(jobId)?.abort();
    return;
  }
  await api.runtime
    .sendMessage({ type: MSG.OFFSCREEN_ABORT, target: 'offscreen', jobId })
    .catch(() => {});
}

/** Release a blob URL once the file has been written to disk. */
export async function releaseAssembled(url) {
  if (!url) return;
  if (!features.offscreen) {
    URL.revokeObjectURL(url);
    return;
  }
  await api.runtime
    .sendMessage({ type: MSG.OFFSCREEN_REVOKE, target: 'offscreen', url })
    .catch(() => {});
}

/** Route progress reports coming back from the offscreen document. */
export function handleOffscreenProgress(message) {
  if (message?.type !== MSG.OFFSCREEN_PROGRESS) return false;
  progressListeners.get(message.jobId)?.(message.progress);
  return true;
}

/** Tear the document down when nothing is left to assemble. */
export async function closeIfIdle(activeAssemblies) {
  if (!features.offscreen || activeAssemblies > 0) return;
  try {
    if (await hasDocument()) await api.offscreen.closeDocument();
  } catch {
    // Closing is best-effort; the document is cheap to leave open.
  }
}
