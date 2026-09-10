/**
 * Shared UI helpers: element creation, background messaging, theme handling
 * and the small pieces of chrome all three pages need.
 */

import { api, runtime } from '../../core/browser-compat.js';
import { getSettings } from '../../core/storage.js';
import { THEME } from '../../core/settings.js';

/* ------------------------------------------------------------------- DOM */

/**
 * Create an element.
 * `props` sets properties; `class`, `dataset`, `attrs` and `on` are special.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'attrs') {
      for (const [name, attr] of Object.entries(value)) {
        if (attr != null && attr !== false) node.setAttribute(name, attr);
      }
    } else if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) {
        node.addEventListener(event, handler);
      }
    } else if (key === 'html') {
      // Only ever used with strings this extension itself produced.
      node.innerHTML = value;
    } else {
      node[key] = value;
    }
  }

  appendAll(node, children);
  return node;
}

function appendAll(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export const $ = (selector, scope = document) => scope.querySelector(selector);
export const $$ = (selector, scope = document) => [...scope.querySelectorAll(selector)];

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function replace(node, ...children) {
  clear(node);
  appendAll(node, children);
  return node;
}

/** Inline SVG icon from a path definition, kept minimal on purpose. */
export function icon(paths, { size = 16, className = 'icon' } = {}) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const definition of [].concat(paths)) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', definition);
    svg.append(path);
  }
  return svg;
}

/** The icon set, as path data. */
export const ICONS = {
  download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 4.5v15l12-7.5z',
  x: 'M18 6 6 18M6 6l12 12',
  retry: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  settings:
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9 2 2 0 1 1 0 4 1.7 1.7 0 0 0-1.5 1.5z',
  video: 'M15 10.5 21 7v10l-6-3.5M3 8a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  audio: 'M9 18V5l10-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm10-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 1 1 8 0v4',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  chevron: 'm6 9 6 6 6-6',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9z',
  refresh: 'M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6',
  trash: 'M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
  sparkle: 'M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z',
};

/* -------------------------------------------------------------- messaging */

/**
 * Send a request to the background and unwrap the standard envelope.
 * Throws with the taxonomy record attached when the background reports one.
 */
export async function request(type, payload = {}) {
  const response = await runtime.sendMessage({ type, ...payload });

  if (response == null) {
    const err = new Error('The extension background did not respond.');
    err.record = {
      code: 'UNKNOWN',
      title: 'The extension background did not respond.',
      hint: 'Reload the page and try again.',
    };
    throw err;
  }

  if (response.ok === false) {
    const err = new Error(response.error?.title ?? 'Request failed');
    err.record = response.error;
    throw err;
  }
  return response;
}

/** Subscribe to a background broadcast. Returns an unsubscribe function. */
export function subscribe(type, handler) {
  const listener = (message) => {
    if (message?.type === type) handler(message);
  };
  runtime.onMessage.addListener(listener);
  return () => runtime.onMessage.removeListener(listener);
}

/* ------------------------------------------------------------------ theme */

/** Apply theme, compact and animation preferences to the document root. */
export function applyAppearance(appearance) {
  const root = document.documentElement;

  if (appearance.theme === THEME.DARK) root.dataset.theme = 'dark';
  else if (appearance.theme === THEME.LIGHT) root.dataset.theme = 'light';
  else delete root.dataset.theme;

  root.dataset.compact = String(!!appearance.compact);
  root.dataset.animations = String(appearance.animations !== false);
}

/** Load settings and apply appearance before the first paint. */
export async function bootAppearance() {
  try {
    const settings = await getSettings();
    applyAppearance(settings.appearance);
    return settings;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------- misc */

/** Open the settings page, or focus it if it is already open. */
export function openSettings() {
  if (api.runtime.openOptionsPage) api.runtime.openOptionsPage();
  else api.tabs.create({ url: api.runtime.getURL('src/ui/options/options.html') });
}

/** A lightweight transient message, anchored to a container. */
export function toast(container, message, { tone = 'default', timeout = 3200 } = {}) {
  const existing = container.querySelector('.toast');
  existing?.remove();

  const node = el(
    'div',
    {
      class: `toast notice fade-in${tone === 'danger' ? ' notice-danger' : tone === 'warn' ? ' notice-warn' : ''}`,
      attrs: { role: 'status' },
    },
    message,
  );
  container.append(node);

  if (timeout) {
    setTimeout(() => {
      node.style.opacity = '0';
      node.style.transition = 'opacity 200ms';
      setTimeout(() => node.remove(), 220);
    }, timeout);
  }
  return node;
}

/** Debounce a function by `wait` milliseconds. */
export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, wait);
  };
}

/** The tab the popup is acting on. */
export async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}
