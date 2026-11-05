/**
 * Clowder AI Service Worker — Push Notification Handler
 *
 * Injected into the Workbox-generated sw.js via @ducanh2912/next-pwa's
 * customWorkerSrc convention (worker/index.ts → importScripts).
 *
 * Excluded from the main web tsconfig (uses worker/tsconfig.json with
 * WebWorker lib instead of DOM). @ducanh2912/next-pwa compiles this
 * file separately via its own webpack config.
 */

/// <reference lib="WebWorker" />
declare const self: ServiceWorkerGlobalScope;

import type { PushNotificationPayload } from '../src/utils/push-notification-policy';
import {
  isPushTestNotificationTag,
  PUSH_TEST_NOTIFICATION_TAG,
  resetPushTestNotification,
  shouldShowSystemNotification,
  shouldSuppressDuplicateNotification,
} from '../src/utils/push-notification-policy';

const dedupeRegistry = new Map<string, number>();

// Static routing (Chromium 123+, which covers Chrome and the Electron 35 desktop shell): API and
// Socket.IO requests go straight to the network without starting this worker. The runtime caching
// built in next.config.js already declines them; this saves the worker start each request would
// otherwise wait for. Every component is a wildcard because the API is usually another port, and a
// pattern given only a pathname inherits this worker's origin. A rejected registration must not
// fail install, or the previous worker would keep controlling the page.
const NETWORK_ONLY_PATHNAMES = ['/api/*', '/socket.io/*'];
type StaticRoute = {
  condition: { urlPattern: { protocol: string; hostname: string; port: string; pathname: string } };
  source: 'network';
};
self.addEventListener('install', (event: ExtendableEvent) => {
  const { addRoutes } = event as ExtendableEvent & { addRoutes?: (routes: StaticRoute[]) => Promise<void> };
  if (typeof addRoutes !== 'function') return;
  const routes = NETWORK_ONLY_PATHNAMES.map(
    (pathname): StaticRoute => ({
      condition: { urlPattern: { protocol: '*', hostname: '*', port: '*', pathname } },
      source: 'network',
    }),
  );
  event.waitUntil(
    addRoutes.call(event, routes).catch((error: unknown) => {
      console.warn('[Clowder AI SW] static routing unavailable; runtime caching still declines API traffic', error);
    }),
  );
});

// Push event: 后端 web-push 推过来的通知
self.addEventListener('push', (event: PushEvent) => {
  let payload: PushNotificationPayload = {};
  try {
    payload = event.data?.json() ?? {};
  } catch {
    payload = { title: '猫猫来信', body: event.data?.text() ?? '' };
  }

  const { title, body, icon, tag, data: notifData } = payload;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      // When Clowder AI is focused, generic replies are suppressed because
      // in-app toast already handles them; forced categories still show.
      const hasFocusedClient = clients.some((c) => c.visibilityState === 'visible');
      if (!shouldShowSystemNotification(payload, hasFocusedClient)) return;
      if (shouldSuppressDuplicateNotification(payload, dedupeRegistry)) return;

      // For test pushes, drop previous same-tag notifications first so each
      // send feels like a fresh system notification without accumulating noise.
      await resetPushTestNotification(self.registration, tag);

      return self.registration.showNotification(title ?? '猫猫来信', {
        body: body ?? '',
        icon: icon ?? '/icons/icon-192x192.png',
        badge: '/icons/icon-192x192.png',
        tag: tag ?? 'cat-cafe-default',
        ...(isPushTestNotificationTag(tag) ? { renotify: true, tag: PUSH_TEST_NOTIFICATION_TAG } : {}),
        data: notifData ?? {},
      });
    }),
  );
});

// Notification click: 跳转到对应对话
self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const targetUrl = (event.notification.data as PushNotificationPayload['data'])?.url ?? '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      // Find existing Clowder AI window
      for (const client of clients) {
        if (new URL(client.url).origin === self.location.origin) {
          return client.focus().then((focused) => {
            if (focused.url !== new URL(targetUrl, self.location.origin).href) {
              return focused.navigate(targetUrl);
            }
            return focused;
          });
        }
      }
      // No window open — open new
      return self.clients.openWindow(targetUrl);
    }),
  );
});
