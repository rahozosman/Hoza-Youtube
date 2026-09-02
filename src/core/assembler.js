/**
 * Segment assembler.
 *
 * HLS and DASH deliver a stream as an ordered list of segments. Concatenating
 * them in order reproduces a playable file: MPEG-TS segments concatenate into
 * a .ts, and fragmented MP4 segments concatenate behind their initialisation
 * segment into a playable .mp4. No re-encoding happens here, and none is
 * claimed — this is a byte-exact join, nothing more.
 *
 * Runs wherever `Blob` exists: the offscreen document in Chromium, the event
 * page in Firefox.
 */

import { MediaError, ErrorCode, fromHttpStatus } from './errors.js';
import { MAX_ASSEMBLED_BYTES } from './constants.js';

const DEFAULT_CONCURRENCY = 4;
const SEGMENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 400;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A pause gate. `wait()` resolves immediately while running, and blocks while
 * paused until `resume()` is called.
 */
function createGate() {
  let paused = false;
  let release = null;
  let barrier = null;

  return {
    get paused() {
      return paused;
    },
    pause() {
      if (paused) return;
      paused = true;
      barrier = new Promise((resolve) => {
        release = resolve;
      });
    },
    resume() {
      if (!paused) return;
      paused = false;
      release?.();
      release = null;
      barrier = null;
    },
    async wait() {
      while (paused) {
        // eslint-disable-next-line no-await-in-loop
        await barrier;
      }
    },
  };
}

async function fetchSegment(segment, signal) {
  const headers = {};
  if (segment.byteRange) {
    headers.Range = `bytes=${segment.byteRange.start}-${segment.byteRange.end}`;
  }

  const response = await fetch(segment.url, {
    signal,
    credentials: 'include',
    headers,
    cache: 'no-store',
  });

  if (!response.ok && !(response.status === 206 && segment.byteRange)) {
    throw new MediaError(
      fromHttpStatus(response.status),
      `segment responded ${response.status}`,
    );
  }
  const buffer = await response.arrayBuffer();
  if (!buffer.byteLength) {
    throw new MediaError(ErrorCode.EMPTY_STREAM, 'segment was empty');
  }
  return buffer;
}

async function fetchWithRetry(segment, signal, onRetry) {
  let lastError = null;
  for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt += 1) {
    if (signal?.aborted) throw new MediaError(ErrorCode.CANCELLED, 'aborted');
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fetchSegment(segment, signal);
    } catch (err) {
      if (err?.name === 'AbortError') throw new MediaError(ErrorCode.CANCELLED, 'aborted');
      // An expired or forbidden URL will not recover by retrying.
      if (
        err instanceof MediaError &&
        (err.code === ErrorCode.SOURCE_FORBIDDEN ||
          err.code === ErrorCode.SOURCE_UNAVAILABLE ||
          err.code === ErrorCode.SOURCE_EXPIRED)
      ) {
        throw err;
      }
      lastError = err;
      if (attempt < SEGMENT_RETRIES) {
        onRetry?.(attempt + 1, err);
        // eslint-disable-next-line no-await-in-loop
        await sleep(RETRY_BASE_DELAY_MS * 2 ** attempt);
      }
    }
  }
  throw lastError ?? new MediaError(ErrorCode.UNKNOWN, 'segment fetch failed');
}

/**
 * Assemble a segmented stream into a single Blob.
 *
 * Segments are fetched with bounded concurrency but written in playlist order,
 * because order is what makes the output playable.
 *
 * @returns {{ promise: Promise<Blob>, pause(): void, resume(): void, abort(): void, isPaused(): boolean }}
 */
export function assemble({
  segments,
  initSegment = null,
  mimeType = 'application/octet-stream',
  concurrency = DEFAULT_CONCURRENCY,
  expectedBytes = null,
  onProgress = null,
}) {
  if (!Array.isArray(segments) || segments.length === 0) {
    return {
      promise: Promise.reject(new MediaError(ErrorCode.EMPTY_STREAM, 'no segments to assemble')),
      pause() {},
      resume() {},
      abort() {},
      isPaused: () => false,
    };
  }

  const controller = new AbortController();
  const gate = createGate();

  const total = segments.length;
  const parts = new Array(total).fill(null);
  let initPart = null;
  let bytesReceived = 0;
  let completed = 0;
  let cursor = 0;

  const report = () => {
    if (!onProgress) return;
    // Once some segments are in, extrapolate the total from the mean size.
    const estimate =
      expectedBytes && expectedBytes > 0
        ? expectedBytes
        : completed > 0
          ? Math.round((bytesReceived / completed) * total)
          : null;
    onProgress({
      bytesReceived,
      totalBytes: estimate,
      completedSegments: completed,
      totalSegments: total,
      paused: gate.paused,
    });
  };

  async function worker() {
    for (;;) {
      if (controller.signal.aborted) return;
      await gate.wait();

      const index = cursor;
      cursor += 1;
      if (index >= total) return;

      const buffer = await fetchWithRetry(segments[index], controller.signal);
      parts[index] = buffer;
      bytesReceived += buffer.byteLength;
      completed += 1;

      if (bytesReceived > MAX_ASSEMBLED_BYTES) {
        throw new MediaError(
          ErrorCode.TOO_LARGE,
          `exceeded ${MAX_ASSEMBLED_BYTES} bytes while assembling`,
        );
      }
      report();
    }
  }

  const promise = (async () => {
    if (initSegment?.url) {
      initPart = await fetchWithRetry(initSegment, controller.signal);
      bytesReceived += initPart.byteLength;
      report();
    }

    const workers = Array.from(
      { length: Math.max(1, Math.min(concurrency, total)) },
      () => worker(),
    );

    try {
      await Promise.all(workers);
    } catch (err) {
      controller.abort();
      throw err;
    }

    if (controller.signal.aborted) {
      throw new MediaError(ErrorCode.CANCELLED, 'assembly aborted');
    }

    const missing = parts.findIndex((part) => part === null);
    if (missing >= 0) {
      throw new MediaError(ErrorCode.NETWORK_INTERRUPTED, `segment ${missing} never arrived`);
    }

    const ordered = initPart ? [initPart, ...parts] : parts;
    const blob = new Blob(ordered, { type: mimeType });

    // Release the buffers as soon as the Blob owns the data.
    parts.length = 0;
    initPart = null;

    return blob;
  })();

  return {
    promise,
    pause: () => gate.pause(),
    resume: () => gate.resume(),
    abort: () => {
      gate.resume();
      controller.abort();
    },
    isPaused: () => gate.paused,
  };
}

/** MIME type to stamp on the assembled Blob, from the container. */
export function mimeForContainer(container) {
  switch (container) {
    case 'mp4':
      return 'video/mp4';
    case 'ts':
      return 'video/mp2t';
    case 'webm':
      return 'video/webm';
    case 'm4a':
      return 'audio/mp4';
    case 'weba':
      return 'audio/webm';
    case 'mp3':
      return 'audio/mpeg';
    case 'aac':
      return 'audio/aac';
    case 'opus':
      return 'audio/opus';
    default:
      return 'application/octet-stream';
  }
}
