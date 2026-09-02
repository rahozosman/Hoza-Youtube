/**
 * Offscreen assembler host.
 *
 * Receives assembly requests from the service worker, runs the segment
 * assembler, streams progress back, and returns a blob URL for the finished
 * file. Blob URLs are retained here so they stay alive until the download has
 * been written, then revoked on request.
 */

import { api } from '../core/browser-compat.js';
import { MSG } from '../core/constants.js';
import { assemble } from '../core/assembler.js';
import { toRecord } from '../core/errors.js';

/** jobId -> assembler handle */
const running = new Map();
/** blob URL -> true, so revocation can be verified as ours */
const issued = new Set();

function reportProgress(jobId, progress) {
  api.runtime
    .sendMessage({ type: MSG.OFFSCREEN_PROGRESS, jobId, progress })
    .catch(() => {
      // The worker may be asleep between reports; progress is advisory.
    });
}

async function handleAssemble(message) {
  const { jobId } = message;

  const handle = assemble({
    segments: message.segments,
    initSegment: message.initSegment,
    mimeType: message.mimeType,
    concurrency: message.concurrency,
    expectedBytes: message.expectedBytes,
    onProgress: (progress) => reportProgress(jobId, progress),
  });

  running.set(jobId, handle);

  try {
    const blob = await handle.promise;
    const url = URL.createObjectURL(blob);
    issued.add(url);
    return { url, size: blob.size };
  } catch (err) {
    return { error: toRecord(err) };
  } finally {
    running.delete(jobId);
  }
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  switch (message.type) {
    case MSG.OFFSCREEN_ASSEMBLE:
      handleAssemble(message).then(sendResponse);
      return true; // response is asynchronous

    case MSG.OFFSCREEN_PAUSE:
      running.get(message.jobId)?.pause();
      sendResponse({ ok: true });
      return false;

    case MSG.OFFSCREEN_RESUME:
      running.get(message.jobId)?.resume();
      sendResponse({ ok: true });
      return false;

    case MSG.OFFSCREEN_ABORT:
      running.get(message.jobId)?.abort();
      sendResponse({ ok: true });
      return false;

    case MSG.OFFSCREEN_REVOKE:
      if (issued.has(message.url)) {
        URL.revokeObjectURL(message.url);
        issued.delete(message.url);
      }
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});
