/**
 * Notifications.
 *
 * Deliberately quiet: one notification when a download finishes, one when it
 * fails for good. Automatic retries stay silent, because a retry that then
 * succeeds was never the user's problem to solve.
 */

import { api, features, asset } from '../core/browser-compat.js';
import { getSettings } from '../core/storage.js';
import { describe } from '../core/errors.js';
import { humanBytes } from '../core/format-utils.js';
import { splitFilename } from '../core/filename.js';

const ICON = 'icons/icon-128.png';

/** notification id -> what clicking it should do */
const actions = new Map();

async function show(id, options) {
  if (!features.notifications) return;
  try {
    await api.notifications.create(id, {
      type: 'basic',
      iconUrl: asset(ICON),
      silent: false,
      ...options,
    });
  } catch {
    // Notifications can be blocked at the OS level; that is not an error worth
    // propagating into a download's outcome.
  }
}

export async function notifyComplete(job) {
  const settings = await getSettings();
  if (!settings.general.notifications || !settings.general.notifyOnComplete) return;

  const { stem, ext } = splitFilename(job.filename);
  const size = Number.isFinite(job.totalBytes) ? humanBytes(job.totalBytes) : null;
  const detail = [job.qualityLabel, ext?.toUpperCase(), size].filter(Boolean).join(' • ');

  const id = `complete:${job.id}`;
  actions.set(id, { kind: 'reveal', downloadId: job.chromeDownloadId });
  await show(id, {
    title: 'Download finished',
    message: stem,
    contextMessage: detail || undefined,
  });
}

export async function notifyFailure(job) {
  const settings = await getSettings();
  if (!settings.general.notifications || !settings.general.notifyOnFailure) return;

  const { title, hint } = describe(job.error?.code);
  const id = `failed:${job.id}`;
  actions.set(id, { kind: 'manager' });
  await show(id, {
    title,
    message: job.title ?? job.filename ?? 'Download failed',
    contextMessage: hint,
  });
}

/** A short-lived note used for things the user triggered but cannot see. */
export async function notifyInfo(message, contextMessage) {
  const settings = await getSettings();
  if (!settings.general.notifications) return;
  const id = `info:${Date.now()}`;
  actions.set(id, { kind: 'manager' });
  await show(id, { title: 'Hoza YT', message, contextMessage });
}

/** Wire click handling. Called once per service-worker start. */
export function attachNotificationListeners({ openManager } = {}) {
  if (!features.notifications) return;

  api.notifications.onClicked?.addListener(async (id) => {
    const action = actions.get(id);
    actions.delete(id);
    try {
      await api.notifications.clear(id);
    } catch {
      // Already dismissed.
    }

    if (action?.kind === 'reveal' && action.downloadId != null) {
      try {
        await api.downloads.show(action.downloadId);
        return;
      } catch {
        // Fall through to the manager page.
      }
    }
    openManager?.();
  });

  api.notifications.onClosed?.addListener((id) => actions.delete(id));
}
