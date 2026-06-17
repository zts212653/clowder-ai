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
