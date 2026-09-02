/**
 * Context-menu integration.
 *
 * Right-clicking a video, an audio player or a direct media link offers the
 * same download path as the panel. Menu items are rebuilt on every service
 * worker start, since `contextMenus` registrations do not survive one.
 */

import { api } from '../core/browser-compat.js';
import { addItem, setPageInfo } from './media-registry.js';
import { isMediaUrl, isManifestUrl } from '../core/format-utils.js';

const IDS = {
  MEDIA: 'hoza-download-media',
  LINK: 'hoza-download-link',
  SCAN: 'hoza-scan-page',
  MANAGER: 'hoza-open-manager',
};

let handlers = {};

export async function installContextMenus(callbacks = {}) {
  handlers = callbacks;
  if (!api.contextMenus) return;

  await new Promise((resolve) => {
    api.contextMenus.removeAll(() => resolve());
  });

  api.contextMenus.create({
    id: IDS.MEDIA,
    title: 'Download this media with Hoza YT',
    contexts: ['video', 'audio'],
  });

  api.contextMenus.create({
    id: IDS.LINK,
    title: 'Download this link with Hoza YT',
    contexts: ['link'],
    // Only offer it where the link plausibly is media; a menu item that
    // usually fails is worse than no menu item.
    targetUrlPatterns: [
      '*://*/*.mp4*', '*://*/*.m4v*', '*://*/*.webm*', '*://*/*.mkv*', '*://*/*.mov*',
      '*://*/*.mp3*', '*://*/*.m4a*', '*://*/*.aac*', '*://*/*.ogg*', '*://*/*.opus*',
      '*://*/*.wav*', '*://*/*.flac*', '*://*/*.m3u8*', '*://*/*.mpd*',
    ],
  });

  api.contextMenus.create({
    id: IDS.SCAN,
    title: 'Scan this page for media',
    contexts: ['page', 'frame'],
  });

  api.contextMenus.create({
    id: IDS.MANAGER,
    title: 'Open Hoza YT downloads',
    contexts: ['action'],
  });
}

async function onClicked(info, tab) {
  const tabId = tab?.id;

  if (info.menuItemId === IDS.MANAGER) {
    handlers.openManager?.();
    return;
  }

  if (info.menuItemId === IDS.SCAN) {
    if (tabId != null) await handlers.scanTab?.(tabId);
    handlers.openPanel?.(tabId);
    return;
  }

  const url = info.menuItemId === IDS.MEDIA ? info.srcUrl : info.linkUrl;
  if (!url || tabId == null) return;

  // A blob: or data: src is the page's own buffer, not something that can be
  // fetched again. Send the user to the panel, where the network-observed
  // streams for this tab are listed instead.
  if (/^(blob|data|filesystem):/i.test(url)) {
    handlers.openPanel?.(tabId);
    return;
  }

  if (!isMediaUrl(url) && !isManifestUrl(url) && info.menuItemId === IDS.LINK) {
    handlers.openPanel?.(tabId);
    return;
  }

  setPageInfo(tabId, { url: info.pageUrl ?? tab?.url ?? null, title: tab?.title ?? null });
  const item = addItem(tabId, {
    url,
    source: 'dom',
    pageUrl: info.pageUrl ?? tab?.url ?? null,
    pageTitle: tab?.title ?? null,
    title: tab?.title ?? null,
  });

  if (item) await handlers.downloadItem?.(tabId, item.id);
}

export function attachContextMenuListeners() {
  api.contextMenus?.onClicked?.addListener((info, tab) => {
    void onClicked(info, tab);
  });
}
