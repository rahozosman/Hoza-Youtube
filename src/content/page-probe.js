/**
 * Content-protection probe (MAIN world).
 *
 * The isolated world cannot see whether a page has negotiated Encrypted Media
 * Extensions, so this runs in the page's own world and watches for it. Its
 * only purpose is to let the panel say "this media is protected" honestly
 * instead of offering a download that would not work.
 *
 * It observes and reports. It does not intercept keys, alter playback, or
 * change what the page is allowed to do — every hooked call is passed straight
 * through to the original implementation, whatever the outcome.
 */

(() => {
  const FLAG = '__hozaPageProbeInstalled';
  if (window[FLAG]) return;
  window[FLAG] = true;

  let announced = false;

  const announce = (reason) => {
    if (announced) return;
    announced = true;
    try {
      window.postMessage({ source: 'hoza-page-probe', kind: 'protected', reason }, location.origin);
    } catch {
      // A page with an exotic origin may reject the post; nothing to do.
    }
  };

  /* ------------------------------------------------- EME key-system access */

  const nav = window.Navigator?.prototype ?? Object.getPrototypeOf(navigator);
  const originalRequest = nav?.requestMediaKeySystemAccess;

  if (typeof originalRequest === 'function') {
    nav.requestMediaKeySystemAccess = function requestMediaKeySystemAccess(keySystem, configs) {
      // Report only on success: a rejected probe means the page tried a key
      // system the browser does not have, which does not imply the media that
      // ends up playing is protected.
      const result = originalRequest.apply(this, arguments);
      try {
        return Promise.resolve(result).then(
          (access) => {
            announce(String(keySystem ?? 'eme'));
            return access;
          },
          (err) => {
            throw err;
          },
        );
      } catch {
        return result;
      }
    };
  }

  /* --------------------------------------------------- element media keys */

  const mediaProto = window.HTMLMediaElement?.prototype;
  const originalSetMediaKeys = mediaProto?.setMediaKeys;

  if (typeof originalSetMediaKeys === 'function') {
    mediaProto.setMediaKeys = function setMediaKeys(keys) {
      if (keys) announce('mediakeys');
      return originalSetMediaKeys.apply(this, arguments);
    };
  }

  /* ------------------------------------------------------- already playing */

  // The probe may be injected after playback started, so check current state.
  const checkExisting = () => {
    for (const element of document.querySelectorAll('video, audio')) {
      if (element.mediaKeys) {
        announce('mediakeys');
        return;
      }
    }
  };

  checkExisting();
  document.addEventListener('encrypted', () => announce('encrypted-event'), true);

  // One deferred check catches players that initialise a moment after load.
  setTimeout(checkExisting, 1500);
})();
