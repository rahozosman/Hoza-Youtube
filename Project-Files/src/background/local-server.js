/**
 * The connection to the local Hoza YT app.
 *
 * The extension does not know where the app is listening, and must not guess.
 * A port can be taken by something else, so the installed app chooses its own
 * and tells us over native messaging — which is also the only channel that can
 * start it in the first place, and the only one that can hand over the session
 * token the API requires. So every conversation begins the same way:
 *
 *     connectNative -> { action: 'start' } -> { state, host, port, token }
 *
 * and only then does any HTTP happen.
 *
 * The states below are the ones a person sees. None of them mentions a port, a
 * process or a command, because none of those is ever the user's problem: the
 * app is installed, it starts itself, and the worst honest answer is that it is
 * unavailable.
 *
 * Nothing here throws. A local app that is still starting is an ordinary state,
 * so failures come back as a record the panel can render as a sentence.
 */

import { api, sendMessageQuiet } from '../core/browser-compat.js';
import { MSG, ServerState, SERVER_STATE_TEXT } from '../core/constants.js';

const NATIVE_HOST = 'com.hoza.yt.server';

/**
 * Where a development server runs. Used only when no native host is registered,
 * which is exactly the case on a machine with a checkout and no installer. It
 * keeps `python server/server.py` working with an unpacked extension, and costs
 * one refused connection on a machine that has neither.
 */
const DEV_ENDPOINT = { host: '127.0.0.1', port: 8765, token: null };

/** Analysis shells out to an extractor, so it is allowed to take a while. */
const TIMEOUT_MS = { default: 8000, analyze: 45000, download: 45000, health: 2500 };

/**
 * How long the app has to become ready before we stop waiting. A cold start
 * is the slow case: the app is launched, it picks a port, and the media engine
 * loads. Reporting a failure early would be reporting one that has not happened.
 */
const HANDSHAKE_TIMEOUT_MS = 90000;

/** After a genuine failure, how long before trying again. Bounded, and reset
 *  by any success or by the user asking for a retry. */
const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];

/** One outstanding analysis per URL, so five reopens do not extract five times. */
const inFlight = new Map();

let state = ServerState.UNKNOWN;
let endpoint = null;
let problem = null;
let nativePort = null;
let handshake = null;
let failures = 0;
let nextAttemptAt = 0;

/* ------------------------------------------------------------------- state */

function describe() {
  return {
    state,
    text: SERVER_STATE_TEXT[state] ?? SERVER_STATE_TEXT[ServerState.UNKNOWN],
    ready: state === ServerState.READY,
    error: problem?.error ?? null,
    hint: problem?.hint ?? null,
  };
}

/** The current connection state, for any surface that shows it. */
export function getState() {
  return describe();
}

function setState(next, issue = null) {
  const changed = next !== state;
  problem = issue;
  state = next;
  if (changed) sendMessageQuiet({ type: MSG.SERVER_STATE, ...describe() });
}

function errorRecord() {
  if (state === ServerState.NOT_INSTALLED) {
    return {
      error: 'Hoza YT is not installed on this computer.',
      code: 'app_missing',
      hint: 'Install Hoza YT to download from this site.',
      retryable: false,
    };
  }
  if (problem) {
    return {
      error: problem.error,
      code: problem.code ?? 'server_offline',
      hint: problem.hint ?? null,
      retryable: problem.retryable !== false,
    };
  }
  return {
    error: 'Hoza YT is starting.',
    code: 'server_offline',
    hint: 'Please wait a moment and try again.',
    retryable: true,
  };
}

/* ------------------------------------------------------ remembering an address
 *
 * A service worker is torn down whenever it is idle, and taking the whole
 * handshake again on every wake would make the first click of every session
 * slow for no reason. Session storage lasts exactly as long as the browser
 * does, which is exactly as long as the address is worth trusting.
 */

async function remember(value) {
  try {
    await api.storage?.session?.set({ hozaEndpoint: value });
  } catch {
    // Session storage is optional; losing it costs one handshake.
  }
}

async function recall() {
  try {
    const stored = await api.storage?.session?.get('hozaEndpoint');
    const value = stored?.hozaEndpoint;
    if (value && typeof value.port === 'number') return value;
  } catch {
    // Fall through to a fresh handshake.
  }
  return null;
}

/* ------------------------------------------------------------------ probing */

/** Is a Hoza YT backend answering at this address, and will it talk to us? */
async function reachable(target) {
  if (!target?.port) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS.health);
  try {
    const response = await fetch(`http://${target.host}:${target.port}/api/health`, {
      headers: target.token ? { 'X-Hoza-Token': target.token } : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null);
    if (payload?.app !== 'hoza-yt') return false;
    if (payload.requires_token && !payload.authenticated) return false;
    return payload.status === 'online' || payload.status === 'degraded';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------- native messaging */

function closeNative() {
  try {
    nativePort?.disconnect();
  } catch {
    // Already gone.
  }
  nativePort = null;
}

/**
 * Ask the installed app to start, and wait for it to say where it is.
 *
 * Resolves with an endpoint, or with null when there is no app to talk to.
 * The port is kept open while waiting because the app reports progress on it:
 * `starting` first, then `ready` with the address, which is what lets the panel
 * say "Starting…" honestly instead of appearing to hang.
 */
function negotiateNative() {
  if (typeof api?.runtime?.connectNative !== 'function') return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    let port;
    try {
      port = api.runtime.connectNative(NATIVE_HOST);
    } catch {
      // No host registered: this browser has no installed app behind it.
      finish(null);
      return;
    }
    nativePort = port;

    port.onMessage.addListener((message) => {
      if (!message || typeof message !== 'object') return;

      if (message.state === 'ready' && typeof message.port === 'number') {
        finish({
          host: message.host || DEV_ENDPOINT.host,
          port: message.port,
          token: message.token ?? null,
        });
        return;
      }
      if (message.state === 'starting' || message.state === 'restarting') {
        setState(ServerState.STARTING);
        return;
      }
      if (message.state === 'crashed' || message.state === 'stopped') {
        problem = {
          error: message.error || 'Hoza YT could not start.',
          hint: message.hint ?? null,
          code: 'app_failed',
        };
        finish(null);
      }
    });

    port.onDisconnect.addListener(() => {
      // Chrome reports a missing host this way rather than by throwing.
      nativePort = null;
      finish(null);
    });

    try {
      port.postMessage({ action: 'start' });
    } catch {
      finish(null);
      return;
    }

    timer = setTimeout(() => finish(null), HANDSHAKE_TIMEOUT_MS);
  });
}

/* --------------------------------------------------------------- handshaking */

async function negotiate() {
  // A remembered address is worth one cheap question before the full dance.
  const remembered = endpoint ?? (await recall());
  if (remembered && (await reachable(remembered))) {
    endpoint = remembered;
    failures = 0;
    setState(ServerState.READY);
    return endpoint;
  }

  if (state === ServerState.READY) setState(ServerState.RECONNECTING);
  else if (state !== ServerState.STARTING) setState(ServerState.CONNECTING);

  const negotiated = await negotiateNative();
  if (negotiated && (await reachable(negotiated))) {
    endpoint = negotiated;
    failures = 0;
    problem = null;
    await remember(endpoint);
    setState(ServerState.READY);
    return endpoint;
  }
  closeNative();

  // No installed app answered. A development server on the usual address is
  // the remaining possibility, and the one a contributor is running.
  if (await reachable(DEV_ENDPOINT)) {
    endpoint = { ...DEV_ENDPOINT };
    failures = 0;
    problem = null;
    await remember(endpoint);
    setState(ServerState.READY);
    return endpoint;
  }

  endpoint = null;
  failures += 1;
  nextAttemptAt = Date.now() + BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
  await remember(null);

  const missing = !problem && typeof api?.runtime?.connectNative !== 'function';
  setState(
    missing ? ServerState.NOT_INSTALLED : ServerState.UNAVAILABLE,
    problem ?? {
      error: 'Hoza YT is not responding.',
      hint: 'It may still be starting. This will keep trying.',
      code: 'server_offline',
    },
  );
  return null;
}

/** The address of the local app, negotiating one if we do not have it. */
async function ensureEndpoint({ force = false } = {}) {
  if (!force && endpoint && state === ServerState.READY) return endpoint;
  if (handshake) return handshake;
  if (!force && !endpoint && Date.now() < nextAttemptAt) return null;

  handshake = negotiate().finally(() => {
    handshake = null;
  });
  return handshake;
}

/** Throw the current address away, so the next call negotiates a fresh one. */
function invalidate() {
  endpoint = null;
  closeNative();
  remember(null);
}

/* ------------------------------------------------------------------ requests */

async function attempt(target, path, { method = 'GET', body = null, timeout } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout ?? TIMEOUT_MS.default);

  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (target.token) headers['X-Hoza-Token'] = target.token;

  try {
    const response = await fetch(`http://${target.host}:${target.port}${path}`, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });

    const data = await response.json().catch(() => null);

    if (response.status === 401) {
      return { ok: false, error: { error: 'stale', code: 'unauthorised', retryable: true } };
    }
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
              error: `Hoza YT reported an error (${response.status}).`,
              code: 'server_error',
              hint: 'The Logs page in the dashboard has the details.',
              retryable: true,
            },
      };
    }
    return { ok: true, data };
  } catch (err) {
    // An abort is a timeout; anything else means nothing was listening.
    if (err?.name === 'AbortError') {
      return {
        ok: false,
        error: {
          error: 'Hoza YT did not answer in time.',
          code: 'server_timeout',
          hint: 'It may be busy with another link.',
          retryable: true,
        },
      };
    }
    return { ok: false, error: { error: 'unreachable', code: 'server_offline', retryable: true } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One call to the local API.
 * Returns `{ ok: true, data }` or `{ ok: false, error: { error, code, hint,
 * retryable } }` — never a rejection.
 *
 * An address that has gone stale is re-negotiated once and the call retried,
 * which is what makes a backend restart invisible from here.
 */
async function request(path, options = {}) {
  const target = await ensureEndpoint();
  if (!target) return { ok: false, error: errorRecord() };

  const first = await attempt(target, path, options);
  if (first.ok) return first;
  if (!['server_offline', 'unauthorised'].includes(first.error.code)) return first;

  invalidate();
  const fresh = await ensureEndpoint({ force: true });
  if (!fresh) return { ok: false, error: errorRecord() };

  const second = await attempt(fresh, path, options);
  if (second.ok) return second;
  if (['server_offline', 'unauthorised'].includes(second.error.code)) {
    return { ok: false, error: errorRecord() };
  }
  return second;
}

/* -------------------------------------------------------------- public calls */

/**
 * Ask the local app to start, without waiting for it.
 *
 * Called when the worker loads and when the browser starts, so the app is
 * usually ready before the first click rather than because of it.
 */
export function wake() {
  ensureEndpoint().catch(() => {});
}

/** Try again now, ignoring any backoff. For a button the user pressed. */
export async function retry() {
  failures = 0;
  nextAttemptAt = 0;
  invalidate();
  await ensureEndpoint({ force: true });
  return describe();
}

/** The dashboard's address, wherever the app turned out to be listening. */
export async function dashboardUrl(params = {}) {
  const target = (await ensureEndpoint()) ?? endpoint ?? DEV_ENDPOINT;
  const query = new URLSearchParams(
    Object.entries(params).filter(([, value]) => value != null && value !== ''),
  );
  const suffix = query.toString();
  return `http://${target.host}:${target.port}/${suffix ? `?${suffix}` : ''}`;
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
