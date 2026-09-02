/**
 * DOM media detection.
 *
 * Runs in the isolated world. Self-contained on purpose: Chromium content
 * scripts cannot be ES modules, so this file imports nothing.
 *
 * It reports what the page exposes — element sources, <source> children and
 * direct media links — plus the title and poster the page itself displays, so
 * downloads get a sensible name. It reads the DOM; it never touches playback.
 */

(() => {
  const FLAG = '__hozaDetectorInstalled';
  if (window[FLAG]) {
    // Re-injected by a second panel open: rescan rather than double-install.
    window.__hozaRescan?.();
    return;
  }
  window[FLAG] = true;

  const MSG_MEDIA_FOUND = 'media:found';
  const MSG_PAGE_INFO = 'page:info';
  const MSG_PAGE_PROTECTED = 'page:protected';

  const MEDIA_EXTENSIONS = new Set([
    'mp4', 'm4v', 'webm', 'mkv', 'mov', 'ogv',
    'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac', 'weba',
  ]);
  const MANIFEST_EXTENSIONS = new Set(['m3u8', 'm3u', 'mpd']);

  /** URLs already reported, so a rescan does not resend the same items. */
  const reported = new Set();
  let lastUrl = location.href;

  const send = (message) => {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // The extension context can be invalidated by a reload; stay silent.
    }
  };

  const absolute = (url) => {
    if (!url) return null;
    try {
      return new URL(url, document.baseURI).toString();
    } catch {
      return null;
    }
  };

  const extensionOf = (url) => {
    try {
      const path = new URL(url).pathname;
      const last = path.split('/').pop() ?? '';
      const dot = last.lastIndexOf('.');
      return dot > 0 ? last.slice(dot + 1).toLowerCase() : null;
    } catch {
      return null;
    }
  };

  const isMediaLike = (url) => {
    const ext = extensionOf(url);
    return !!ext && (MEDIA_EXTENSIONS.has(ext) || MANIFEST_EXTENSIONS.has(ext));
  };

  /* ------------------------------------------------------------- metadata */

  const metaContent = (selector) =>
    document.querySelector(selector)?.getAttribute('content')?.trim() || null;

  /** The page's own idea of its title, preferring Open Graph over <title>. */
  function pageTitle() {
    return (
      metaContent('meta[property="og:title"]') ||
      metaContent('meta[name="twitter:title"]') ||
      document.querySelector('h1')?.textContent?.trim() ||
      document.title?.trim() ||
      null
    );
  }

  function pageThumbnail() {
    const url =
      metaContent('meta[property="og:image"]') || metaContent('meta[name="twitter:image"]');
    return url ? absolute(url) : null;
  }

  /**
   * A title for one element, working outwards: an explicit label, then the
   * poster's alt text, then the page title.
   */
  function titleFor(element) {
    const own =
      element.getAttribute('title') ||
      element.getAttribute('aria-label') ||
      element.getAttribute('data-title');
    if (own?.trim()) return own.trim();

    const labelledBy = element.getAttribute('aria-labelledby');
    if (labelledBy) {
      const label = document.getElementById(labelledBy)?.textContent?.trim();
      if (label) return label;
    }

    // A figure or article wrapping the player usually carries the real title.
    const container = element.closest('figure, article, section, [role="region"]');
    const heading = container?.querySelector('figcaption, h1, h2, h3')?.textContent?.trim();
    if (heading) return heading;

    return pageTitle();
  }

  /* -------------------------------------------------------------- scanning */

  function collectFromElement(element, out) {
    const isVideo = element.tagName === 'VIDEO';
    const poster = isVideo ? absolute(element.getAttribute('poster')) : null;
    const duration = Number.isFinite(element.duration) && element.duration > 0
      ? element.duration
      : null;

    const candidates = [];
    const current = element.currentSrc || element.getAttribute('src');
    if (current) candidates.push(current);
    for (const source of element.querySelectorAll('source')) {
      const src = source.getAttribute('src');
      if (src) candidates.push(src);
    }

    let sawBuffered = false;

    for (const candidate of candidates) {
      const url = absolute(candidate);
      if (!url) continue;

      // A blob: or MediaSource src is the page's own buffer. It cannot be
      // fetched again, so it is not offered; the network observer supplies the
      // underlying manifest for these instead.
      if (/^(blob|data|mediasource|filesystem):/i.test(url)) {
        sawBuffered = true;
        continue;
      }
      if (!/^https?:/i.test(url)) continue;

      if (reported.has(url)) continue;
      reported.add(url);

      out.push({
        url,
        title: titleFor(element),
        thumbnail: poster ?? pageThumbnail(),
        duration,
        width: element.videoWidth || null,
        height: element.videoHeight || null,
        pageUrl: location.href,
        pageTitle: pageTitle(),
        element: isVideo ? 'video' : 'audio',
      });
    }

    return sawBuffered;
  }

  /** Direct links to media files, which are downloadable as they stand. */
  function collectLinks(out) {
    for (const anchor of document.querySelectorAll('a[href]')) {
      const url = absolute(anchor.getAttribute('href'));
      if (!url || !/^https?:/i.test(url)) continue;
      if (!isMediaLike(url)) continue;
      if (reported.has(url)) continue;
      reported.add(url);

      out.push({
        url,
        title: anchor.textContent?.trim() || titleFor(anchor),
        thumbnail: pageThumbnail(),
        duration: null,
        pageUrl: location.href,
        pageTitle: pageTitle(),
        element: 'link',
      });
    }
  }

  function scan() {
    const found = [];
    let bufferedOnly = false;

    for (const element of document.querySelectorAll('video, audio')) {
      if (collectFromElement(element, found)) bufferedOnly = true;
    }
    collectLinks(found);

    send({
      type: MSG_PAGE_INFO,
      pageInfo: {
        url: location.href,
        title: pageTitle(),
        thumbnail: pageThumbnail(),
        hasBufferedMedia: bufferedOnly,
      },
    });

    if (found.length) send({ type: MSG_MEDIA_FOUND, items: found });
  }

  function handleNavigation() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    reported.clear();
    scan();
  }

  // YouTube changes videos through the History API without rebuilding the
  // document, so a DOM-only observer never sees the navigation itself.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function wrappedHistoryMethod() {
      const result = original.apply(this, arguments);
      handleNavigation();
      return result;
    };
  }
  window.addEventListener('popstate', handleNavigation);
  window.addEventListener('hashchange', handleNavigation);

  window.__hozaRescan = () => {
    reported.clear();
    scan();
  };

  /* -------------------------------------------------------------- watching */

  let scanTimer = null;
  const scheduleScan = () => {
    if (scanTimer != null) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scan();
    }, 400);
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') {
        scheduleScan();
        return;
      }
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (
          node.tagName === 'VIDEO' ||
          node.tagName === 'AUDIO' ||
          node.tagName === 'SOURCE' ||
          node.querySelector?.('video, audio')
        ) {
          scheduleScan();
          return;
        }
      }
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'poster'],
  });

  // Duration and dimensions are only known once metadata has loaded.
  document.addEventListener('loadedmetadata', scheduleScan, true);
  document.addEventListener('durationchange', scheduleScan, true);

  /* --------------------------------------- relay from the MAIN-world probe */

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data?.source !== 'hoza-page-probe') return;

    if (data.kind === 'protected') {
      send({ type: MSG_PAGE_PROTECTED, reason: data.reason ?? 'encrypted' });
    }
  });

  scan();
})();
