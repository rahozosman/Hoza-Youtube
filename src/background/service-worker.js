/**
 * Service worker: message router and lifecycle owner.
 *
 * Every listener is registered at the top level, because Chromium tears this
 * worker down whenever it is idle and replays events against a fresh one.
 * Nothing here assumes it has been running.
 */

import { api, asset, sendMessageQuiet } from '../core/browser-compat.js';
import { MSG, DetectState, Delivery, StreamType } from '../core/constants.js';
import { MediaError, ErrorCode, toRecord } from '../core/errors.js';
import { getSettings, updateSettings, resetSettings, getSitePrefs, setSitePrefs, getAllSitePrefs } from '../core/storage.js';
import { originPattern, originKey } from '../core/settings.js';
import { pickSmart, assignBadges } from '../core/quality-resolver.js';
import { findDuplicate, describeDuplicate, fingerprint } from '../core/dedupe.js';

import * as registry from './media-registry.js';
import * as queue from './queue-manager.js';
import * as history from './history.js';
import { analyzeItem } from './manifest-probe.js';
import { startNetworkObserver, setDisabledOrigins } from './net-observer.js';
import {
  attachDownloadListeners,
  revealFile,
  openFile,
} from './download-manager.js';
import { attachNotificationListeners, notifyInfo } from './notifications.js';
import { installContextMenus, attachContextMenuListeners } from './context-menu.js';
import { handleOffscreenProgress } from './offscreen-bridge.js';
import * as local from './local-server.js';

const MANAGER_PAGE = 'src/ui/manager/manager.html';

/* ------------------------------------------------------------- page access */

/** Does the extension already hold host permission for this tab's origin? */
async function hasSiteAccess(url) {
  const pattern = originPattern(url);
  if (!pattern) return false;
  try {
    return await api.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * Run the DOM scan in a tab. Works under `activeTab` when the user opened the
 * panel, and under a granted host permission otherwise.
 */
async function scanTab(tabId) {
  try {
    await api.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['src/content/detector.js'],
    });
    // The MAIN-world probe reports content protection, which the isolated
    // world cannot observe.
    await api.scripting
      .executeScript({
        target: { tabId, allFrames: true },
        files: ['src/content/page-probe.js'],
        world: 'MAIN',
      })
      .catch(() => {});
    // Content scripts report asynchronously through runtime messages. Give
    // the registry a brief window to receive the initial DOM scan before the
    // caller snapshots it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    return true;
  } catch (err) {
    // No access to this tab: a browser-internal page, the web store, or an
    // origin the user has not granted.
    return false;
  }
}

/** True for pages no extension may touch, so the UI can say why. */
function isRestrictedUrl(url) {
  return (
    !url ||
    /^(chrome|edge|about|moz-extension|chrome-extension|devtools|view-source):/i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com/i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore/i.test(url)
  );
}

/* ---------------------------------------------------------------- detection */

/**
 * Assemble everything the panel needs for one tab: the page identity, the
 * detected media, and why the list looks the way it does.
 */
async function buildTabState(tabId, { scan = true } = {}) {
  const tab = await api.tabs.get(tabId).catch(() => null);
  const url = tab?.url ?? null;

  if (isRestrictedUrl(url)) {
    return { state: DetectState.UNSUPPORTED_PAGE, items: [], pageInfo: null, hasAccess: false };
  }

  registry.setPageInfo(tabId, { url, title: tab?.title ?? null });

  const settings = await getSettings();
  const sitePrefs = await getSitePrefs(url);
  const hasAccess = await hasSiteAccess(url);

  if (settings.detection.enabled && sitePrefs.detection && scan) {
    await scanTab(tabId);
  }

  const snapshot = registry.snapshot(tabId);
  const items = snapshot.items;

  let state;
  if (!settings.detection.enabled || !sitePrefs.detection) {
    state = DetectState.NONE;
  } else if (snapshot.protectedReason && items.length === 0) {
    state = DetectState.PROTECTED;
  } else if (items.length === 0) {
    state = hasAccess ? DetectState.NONE : DetectState.NO_ACCESS;
  } else if (items.length > 1) {
    state = DetectState.MULTIPLE;
  } else {
    state = DetectState.FOUND;
  }

  return {
    state,
    items,
    pageInfo: snapshot.pageInfo,
    protectedReason: snapshot.protectedReason,
    hasAccess,
    sitePrefs,
    settings,
    detectionEnabled: settings.detection.enabled && sitePrefs.detection,
  };
}

/** Analyse one item and write the resulting streams back into the registry. */
async function analyze(tabId, itemId) {
  const item = registry.getItem(tabId, itemId);
  if (!item) throw new MediaError(ErrorCode.SOURCE_UNAVAILABLE, 'media is no longer listed');
  if (item.analyzed) return item;

  registry.updateItem(tabId, itemId, { analyzing: true, error: null });

  try {
    const result = await analyzeItem(item);
    return registry.updateItem(tabId, itemId, {
      analyzing: false,
      analyzed: true,
      streams: result.streams,
      duration: item.duration ?? result.duration,
      partiallyProtected: !!result.partiallyProtected,
      error: null,
    });
  } catch (err) {
    const record = toRecord(err);
    registry.updateItem(tabId, itemId, {
      analyzing: false,
      analyzed: false,
      streams: [],
      error: record,
      protected: record.code === ErrorCode.PROTECTED_MEDIA,
    });
    throw err;
  }
}

/* ---------------------------------------------------------------- download */

/**
 * Start a download, checking for duplicates first.
 * Returns `{ status: 'started' | 'duplicate' | 'skipped', ... }`.
 */
async function startDownload({ tabId, itemId, streamId, conflict = null, filenameOverride = null }) {
  const item = registry.getItem(tabId, itemId);
  if (!item) throw new MediaError(ErrorCode.SOURCE_UNAVAILABLE, 'media is no longer listed');

  const stream = item.streams.find((candidate) => candidate.id === streamId);
  if (!stream) throw new MediaError(ErrorCode.SOURCE_UNAVAILABLE, 'that quality is no longer listed');

  const settings = await getSettings();
  const media = { ...item, streams: undefined };

  if (!conflict && settings.downloads.duplicatePolicy === 'ask') {
    const { job } = await queue.prepareJob({ media, stream, filenameOverride });
    const duplicate = findDuplicate(
      { filename: job.filename, url: job.url, fingerprint: job.fingerprint },
      { history: await history.all(), jobs: queue.list() },
    );
    if (duplicate) {
      return {
        status: 'duplicate',
        message: describeDuplicate(duplicate),
        reason: duplicate.reason,
        filename: job.filename,
        existing: {
          filename: duplicate.match.filename,
          finishedAt: duplicate.match.finishedAt ?? null,
          state: duplicate.match.state ?? null,
        },
        request: { tabId, itemId, streamId },
      };
    }
  }

  // A non-interactive policy resolves itself.
  let effectiveConflict = conflict;
  if (!effectiveConflict && settings.downloads.duplicatePolicy !== 'ask') {
    effectiveConflict = settings.downloads.duplicatePolicy;
  }
  if (effectiveConflict === 'skip') {
    return { status: 'skipped' };
  }

  const job = await queue.enqueue({
    media,
    stream,
    filenameOverride,
    conflict: effectiveConflict,
  });
  return { status: 'started', job };
}

/**
 * One-click: analyse the most promising item on the page and download the
 * stream matching the user's remembered preference, degrading to the closest
 * available quality rather than failing.
 */
async function quickDownload(tabId) {
  const settings = await getSettings();
  const tabState = await buildTabState(tabId);

  if (!tabState.items.length) {
    await notifyInfo('Nothing to download', 'No media was detected on this page.');
    return { status: 'none' };
  }

  // Prefer a manifest, which describes several qualities, over a lone file.
  const candidates = tabState.items.filter((item) => !item.protected);
  let lastError = null;

  for (const candidate of candidates) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const analyzed = await analyze(tabId, candidate.id);
      const stream = pickSmart(analyzed.streams, settings.general.smartMode, {
        preferredHeight: settings.general.preferredHeight,
        preferredContainer: settings.general.preferredContainer,
        preferredVideoCodec: settings.general.preferredVideoCodec,
      });
      if (!stream) continue;

      // eslint-disable-next-line no-await-in-loop
      const result = await startDownload({
        tabId,
        itemId: candidate.id,
        streamId: stream.id,
        conflict: settings.downloads.duplicatePolicy === 'ask' ? 'rename' : null,
      });

      if (result.status === 'started') {
        await notifyInfo('Download started', `${result.job.title} • ${result.job.qualityLabel}`);
      }
      return result;
    } catch (err) {
      lastError = err;
    }
  }

  const record = toRecord(lastError ?? new MediaError(ErrorCode.SOURCE_UNAVAILABLE));
  await notifyInfo(record.title, record.hint);
  return { status: 'failed', error: record };
}

/* ------------------------------------------------------------------- pages */

async function openManager(section = 'active') {
  const url = asset(`${MANAGER_PAGE}#${section}`);
  const base = asset(MANAGER_PAGE);
  const existing = await api.tabs.query({ url: `${base}*` }).catch(() => []);
  if (existing?.length) {
    await api.tabs.update(existing[0].id, { active: true, url });
    await api.windows?.update(existing[0].windowId, { focused: true }).catch(() => {});
    return existing[0].id;
  }
  const tab = await api.tabs.create({ url });
  return tab.id;
}

async function openDashboard(url, title = null) {
  const dashboardUrl = `http://127.0.0.1:8765/?url=${encodeURIComponent(url ?? '')}`;
  const tab = await api.tabs.create({ url: dashboardUrl });
  return { tabId: tab.id, title };
}

/* ---------------------------------------------------------------- messages */

const handlers = {
  async [MSG.GET_TAB_STATE]({ tabId, scan }) {
    return buildTabState(tabId, { scan: scan !== false });
  },

  async [MSG.RESCAN]({ tabId }) {
    registry.resetForNavigation(tabId, registry.getPageInfo(tabId));
    return buildTabState(tabId, { scan: true });
  },

  async [MSG.ANALYZE_MEDIA]({ tabId, itemId }) {
    const item = await analyze(tabId, itemId);
    return { item };
  },

  async [MSG.START_DOWNLOAD](payload) {
    return startDownload(payload);
  },

  async [MSG.QUICK_DOWNLOAD]({ tabId }) {
    return quickDownload(tabId);
  },

  async [MSG.PAUSE_JOB]({ id }) {
    return { ok: await queue.pause(id) };
  },

  async [MSG.RESUME_JOB]({ id }) {
    return { ok: await queue.resume(id) };
  },

  async [MSG.CANCEL_JOB]({ id }) {
    return { ok: await queue.cancel(id) };
  },

  async [MSG.RETRY_JOB]({ id }) {
    return { ok: await queue.retry(id) };
  },

  async [MSG.REMOVE_JOB]({ id, fromHistory }) {
    if (fromHistory) return { ok: await history.remove(id) };
    return { ok: queue.remove(id) };
  },

  async [MSG.PAUSE_ALL]() {
    await queue.pauseAll();
    return { ok: true };
  },

  async [MSG.RESUME_ALL]() {
    await queue.resumeAll();
    return { ok: true };
  },

  async [MSG.REORDER_QUEUE]({ id, index }) {
    return { ok: queue.reorder(id, index) };
  },

  async [MSG.GET_JOBS]() {
    return { jobs: queue.list(), pausedGlobally: queue.isPausedGlobally() };
  },

  async [MSG.GET_HISTORY]() {
    return { entries: await history.all() };
  },

  async [MSG.CLEAR_HISTORY]({ scope }) {
    return { remaining: await history.clear(scope) };
  },

  async [MSG.REVEAL_FILE]({ downloadId }) {
    return { ok: await revealFile(downloadId) };
  },

  async [MSG.OPEN_FILE]({ downloadId }) {
    return { ok: await openFile(downloadId) };
  },

  async [MSG.GET_SETTINGS]() {
    return { settings: await getSettings(), sites: await getAllSitePrefs() };
  },

  async [MSG.SET_SETTINGS]({ patch }) {
    const settings = await updateSettings(patch);
    await refreshDisabledOrigins();
    return { settings };
  },

  async [MSG.RESET_SETTINGS]() {
    return { settings: await resetSettings() };
  },

  async [MSG.GET_SITE_ACCESS]({ url }) {
    return { hasAccess: await hasSiteAccess(url), pattern: originPattern(url) };
  },

  async 'site:prefs:set'({ url, patch }) {
    const prefs = await setSitePrefs(url, patch);
    await refreshDisabledOrigins();
    return { prefs };
  },

  async [MSG.OPEN_MANAGER]({ section }) {
    return { tabId: await openManager(section) };
  },

  async [MSG.OPEN_DASHBOARD]({ url, title }) {
    return openDashboard(url, title);
  },

  /* ---- the in-page panel's bridge to the local Hoza YT server ---- */

  async [MSG.SERVER_ANALYZE]({ url, refresh }) {
    return local.analyze(url, { refresh: !!refresh });
  },

  async [MSG.SERVER_DOWNLOAD]({ url, selection }) {
    return local.createJob({ url, selection });
  },

  async [MSG.SERVER_JOBS]({ limit }) {
    return local.listJobs({ limit });
  },

  async [MSG.SERVER_ABOUT]() {
    return local.about();
  },
};

/** Keep the network observer's skip-list in step with per-site preferences. */
async function refreshDisabledOrigins() {
  const all = await getAllSitePrefs();
  const disabled = Object.entries(all)
    .filter(([, prefs]) => prefs?.detection === false)
    .map(([origin]) => origin);
  setDisabledOrigins(disabled);
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Offscreen progress is a notification, not a request.
  if (handleOffscreenProgress(message)) return false;
  if (message?.target === 'offscreen') return false;

  // Reports pushed by content scripts, which expect no reply.
  if (message?.type === MSG.MEDIA_FOUND) {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      for (const found of message.items ?? []) {
        registry.addItem(tabId, { ...found, source: 'dom' });
      }
      void sendMessageQuiet({ type: MSG.MEDIA_CHANGED, tabId });
    }
    return false;
  }

  if (message?.type === MSG.PAGE_INFO) {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      const pageInfo = message.pageInfo ?? {};
      const previous = registry.getPageInfo(tabId);
      if (previous?.url && pageInfo.url && previous.url !== pageInfo.url) {
        registry.resetForNavigation(tabId, pageInfo);
      } else {
        registry.setPageInfo(tabId, pageInfo);
      }
    }
    return false;
  }

  if (message?.type === MSG.PAGE_PROTECTED) {
    const tabId = sender.tab?.id;
    if (tabId != null) registry.markProtected(tabId, message.reason);
    return false;
  }

  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message ?? {})
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: toRecord(err) }));

  return true; // response is asynchronous
});

/* -------------------------------------------------------------- lifecycle */

attachDownloadListeners();
attachContextMenuListeners();
attachNotificationListeners({ openManager: () => void openManager() });

/**
 * Attach the network observer. `webRequest` is an optional permission, so on a
 * fresh install the namespace does not exist yet and this is a no-op; it is
 * called again from `permissions.onAdded` once the user grants a site.
 */
function attachNetworkObserver() {
  startNetworkObserver({
    onMedia: (tabId) => {
      void sendMessageQuiet({ type: MSG.MEDIA_CHANGED, tabId });
    },
  });
}

attachNetworkObserver();

api.permissions?.onAdded?.addListener(() => {
  attachNetworkObserver();
  void refreshDisabledOrigins();
});

api.runtime.onInstalled.addListener(() => {
  void installContextMenus({
    openManager: () => void openManager(),
    openPanel: () => void api.action?.openPopup?.().catch(() => {}),
    scanTab: (tabId) => scanTab(tabId),
    downloadItem: async (tabId, itemId) => {
      try {
        const analyzed = await analyze(tabId, itemId);
        const settings = await getSettings();
        const stream = pickSmart(analyzed.streams, settings.general.smartMode, {
          preferredHeight: settings.general.preferredHeight,
          preferredContainer: settings.general.preferredContainer,
        });
        if (!stream) throw new MediaError(ErrorCode.EMPTY_STREAM, 'nothing downloadable was found');
        await startDownload({ tabId, itemId, streamId: stream.id, conflict: 'rename' });
        await notifyInfo('Download started', analyzed.title ?? '');
      } catch (err) {
        const record = toRecord(err);
        await notifyInfo(record.title, record.hint);
      }
    },
  });
});

api.runtime.onStartup?.addListener(() => {
  void queue.restore();
  void refreshDisabledOrigins();
});

api.commands?.onCommand?.addListener(async (command) => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });

  if (command === 'quick-download') {
    if (tab?.id != null) await quickDownload(tab.id);
    return;
  }
  if (command === 'open-manager') {
    await openManager();
    return;
  }
  if (command === 'toggle-pause-all') {
    if (queue.isPausedGlobally()) await queue.resumeAll();
    else await queue.pauseAll();
  }
});

// Losing a tab must not leave its jobs orphaned in the registry.
api.tabs?.onRemoved?.addListener((tabId) => registry.clearTab(tabId));

// Restore immediately: the worker may have been woken by a download event
// rather than by the user opening the panel.
void queue.restore();
void refreshDisabledOrigins();

export { StreamType, Delivery, fingerprint };
