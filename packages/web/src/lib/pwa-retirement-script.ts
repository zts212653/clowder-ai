const CAT_CAFE_PWA_RUNTIME_CACHES = [
  'start-url',
  'google-fonts-webfonts',
  'google-fonts-stylesheets',
  'static-font-assets',
  'static-image-assets',
  'next-static-js-assets',
  'next-image',
  'static-audio-assets',
  'static-video-assets',
  'static-js-assets',
  'static-style-assets',
  'next-data',
  'static-data-assets',
  'apis',
  'pages-rsc-prefetch',
  'pages-rsc',
  'pages',
  'cross-origin',
  'static-assets',
] as const;

export function buildPwaRetirementScript({ enabled }: { enabled: boolean }): string {
  if (enabled) return '';
  const config = JSON.stringify({ cacheNames: CAT_CAFE_PWA_RUNTIME_CACHES });

  return `(async function retireCatCafePwa(config) {
  const status = document.querySelector('[data-cat-cafe-pwa-retirement]');
  const publish = (state, controller, remainingOwnedCaches, failures) => {
    const report = { state, controller, remainingOwnedCaches, failures };
    if (status) {
      status.dataset.pwaCleanupState = state;
      status.dataset.pwaController = controller;
      status.dataset.pwaOwnedCacheCount = String(remainingOwnedCaches.length);
      status.dataset.pwaOwnedCaches = remainingOwnedCaches.join(',');
      status.dataset.pwaFailureCount = String(failures.length);
    }
    document.dispatchEvent(new CustomEvent('catcafe:pwa-retirement', { detail: report }));
    if (state === 'failed') console.error('[Clowder AI PWA] disabled cleanup failed', failures);
  };
  const failureText = (error) => error instanceof Error ? error.message : String(error);
  const workerScriptURL = (registration) =>
    registration.active?.scriptURL || registration.waiting?.scriptURL || registration.installing?.scriptURL || null;
  const isCatCafeWorker = (scriptURL) => {
    if (!scriptURL) return false;
    try {
      const url = new URL(scriptURL);
      return url.origin === location.origin && url.pathname === '/sw.js';
    } catch {
      return false;
    }
  };
  const serviceWorker = navigator.serviceWorker;
  if (!serviceWorker || typeof serviceWorker.getRegistrations !== 'function' ||
      typeof caches === 'undefined' || typeof caches.keys !== 'function' || typeof caches.delete !== 'function') {
    publish('failed', serviceWorker?.controller ? 'present' : 'none', [], ['PWA cleanup APIs unavailable']);
    return;
  }

  let registrations;
  let cacheNames;
  try {
    [registrations, cacheNames] = await Promise.all([serviceWorker.getRegistrations(), caches.keys()]);
  } catch (error) {
    publish('failed', serviceWorker.controller ? 'present' : 'none', [], [
      'failed to inspect PWA state: ' + failureText(error),
    ]);
    return;
  }

  const controllerScriptURL = serviceWorker.controller?.scriptURL || null;
  if (controllerScriptURL && !isCatCafeWorker(controllerScriptURL)) {
    publish('failed', 'present', [], ['refusing to retire an unrecognized service worker: ' + controllerScriptURL]);
    return;
  }
  const catCafeRegistrations = registrations.filter((registration) => isCatCafeWorker(workerScriptURL(registration)));
  const ownedCacheNames = new Set(config.cacheNames);
  ownedCacheNames.add('workbox-precache-v2-' + new URL('/', location.origin).href);
  for (const registration of catCafeRegistrations) {
    try {
      const scope = new URL(registration.scope);
      if (scope.origin === location.origin) ownedCacheNames.add('workbox-precache-v2-' + scope.href);
    } catch {
      // An invalid scope cannot grant ownership over any cache name.
    }
  }
  const ownedCaches = cacheNames.filter((name) => ownedCacheNames.has(name));
  const failures = [];
  for (const registration of catCafeRegistrations) {
    try {
      if (!(await registration.unregister())) {
        failures.push('service worker refused to unregister: ' + registration.scope);
      }
    } catch (error) {
      failures.push('service worker unregister failed for ' + registration.scope + ': ' + failureText(error));
    }
  }
  if (failures.length > 0) {
    publish('failed', controllerScriptURL ? 'present' : 'none', ownedCaches, failures);
    return;
  }

  const remainingOwnedCaches = [];
  for (const name of ownedCaches) {
    try {
      if (!(await caches.delete(name))) {
        remainingOwnedCaches.push(name);
        failures.push('cache refused deletion: ' + name);
      }
    } catch (error) {
      remainingOwnedCaches.push(name);
      failures.push('cache deletion failed for ' + name + ': ' + failureText(error));
    }
  }
  try {
    const observedCacheNames = await caches.keys();
    for (const name of observedCacheNames) {
      if (ownedCacheNames.has(name) && !remainingOwnedCaches.includes(name)) remainingOwnedCaches.push(name);
    }
    if (remainingOwnedCaches.length > 0 && failures.length === 0) {
      failures.push('owned PWA caches remain after cleanup: ' + remainingOwnedCaches.join(','));
    }
  } catch (error) {
    failures.push('failed to verify PWA cache cleanup: ' + failureText(error));
  }
  if (failures.length > 0) {
    publish('failed', controllerScriptURL ? 'present' : 'none', remainingOwnedCaches, failures);
    return;
  }

  const state = controllerScriptURL ? 'reload-required' : 'clean';
  publish(state, controllerScriptURL ? 'present' : 'none', [], []);
  if (controllerScriptURL) location.reload();
})(${config});`;
}
