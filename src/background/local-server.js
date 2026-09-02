/**
 * Bridge to the local Hoza YT server.
 *
 * The in-page panel lives in a YouTube tab, so it cannot call the local API
 * itself: the server only accepts `chrome-extension://` and loopback origins.
 * Every request is therefore made from here, where the origin is the
 * extension's own.
 *
 * Nothing in this module throws. A local app that is not running is an
 * ordinary, expected state, so failures come back as a record the panel can
 * render as a sentence.
 */

const ORIGIN = 'http://127.0.0.1:8765';

/** Analysis shells out to an extractor, so it is allowed to take a while. */
const TIMEOUT_MS = { default: 8000, analyze: 45000, download: 45000 };

/** One outstanding analysis per URL, so five reopens do not extract five times. */
const inFlight = new Map();

const OFFLINE = {
  error: 'The Hoza YT app is not running.',
  code: 'server_offline',
  hint: 'It starts on its own a few seconds after the browser does. Give it a moment.',
  retryable: true,
};

/**
 * The app is started for us when the browser opens, so the very first call of
 * a session can arrive in the second or two before it is listening. A refused
 * connection is retried across that window instead of being reported, which is
 * what stops an ordinary cold start from looking like a failure. Once the app
 * has answered even once, a much shorter window is enough.
 */
const WAKE_MS = { cold: 15000, warm: 4000, between: 500 };

let everAnswered = false;

/**
 * One call to the local API.
 * Returns `{ ok: true, data }` or `{ ok: false, error: { error, code, hint,
 * retryable } }` — never a rejection.
 */
async function attempt(path, { method = 'GET', body = null, timeout = TIMEOUT_MS.default } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      return {
        ok: false,
        error: data?.error
          ? {
              error: data.error,
              code: data.code ?? 'error',
              hint: data.hint ?? null,
              retryable: !!data.retryable,
            }
          : {
              error: `The local app replied with an error (${response.status}).`,
              code: 'server_error',
              hint: 'The Logs page in the dashboard has the details.',
              retryable: true,
            },
      };
    }

    everAnswered = true;
    return { ok: true, data };
  } catch (err) {
    // An abort is a timeout here; anything else means nothing was listening.
    if (err?.name === 'AbortError') {
      return {
        ok: false,
        error: {
          error: 'The local app did not answer in time.',
          code: 'server_timeout',
          hint: 'It may still be starting up, or busy with another link.',
          retryable: true,
        },
      };
    }
    return { ok: false, error: { ...OFFLINE } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call the local API, waiting out a cold start rather than reporting one.
 * Only a refused connection is worth retrying: a timeout, or an error the app
 * itself sent back, means something is listening and has already had its say.
 */
async function request(path, options = {}) {
  const deadline = Date.now() + (everAnswered ? WAKE_MS.warm : WAKE_MS.cold);

  for (;;) {
    const result = await attempt(path, options);
    if (result.ok || result.error.code !== 'server_offline') return result;
    if (Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, WAKE_MS.between));
  }
}

/** Every quality this link offers, video and audio, with real figures. */
export function analyze(url, { refresh = false } = {}) {
  const key = `${refresh ? 'fresh:' : ''}${url}`;
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = request('/api/analyze', {
    method: 'POST',
    body: { url, refresh },
    timeout: TIMEOUT_MS.analyze,
  }).finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

/** Queue one download from a quality the user picked in the panel. */
export function createJob({ url, selection }) {
  return request('/api/jobs', {
    method: 'POST',
    body: { url, selection },
    timeout: TIMEOUT_MS.download,
  });
}

/** The jobs the panel shows while it is open. */
export function listJobs({ limit = 12 } = {}) {
  return request(`/api/jobs?limit=${limit}`);
}

/** Developer, contact and build details for the About section. */
export function about() {
  return request('/api/about');
}

/** Let the dashboard know a browser extension is present. */
export function ping({ version = null, browser = 'chrome' } = {}) {
  return request('/api/extension/ping', { method: 'POST', body: { version, browser } });
}
