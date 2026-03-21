/**
 * Push Notification Service
 * 通过 Web Push 向铲屎官的所有设备推送通知
 *
 * Best-effort: 推送失败不影响主流程，410 Gone 自动清理过期订阅
 */

import webpush from 'web-push';
import { createModuleLogger } from '../../../../infrastructure/logger.js';
import type { IPushSubscriptionStore, PushSubscriptionRecord } from '../stores/ports/PushSubscriptionStore.js';

const log = createModuleLogger('push-notification');

const DEFAULT_WEB_PUSH_TIMEOUT_MS = 10_000;

function asNonEmptyString(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isHttpProxyUrl(value: string): boolean {
  return value.startsWith('http://') || value.startsWith('https://');
}

function resolveWebPushProxy(): string | undefined {
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
  ];

  for (const candidate of candidates) {
    const proxy = asNonEmptyString(candidate);
    if (!proxy) continue;
    if (isHttpProxyUrl(proxy)) return proxy;
  }
  return undefined;
}

function resolveWebPushTimeoutMs(): number {
  const raw = asNonEmptyString(process.env.WEB_PUSH_TIMEOUT_MS);
  if (!raw) return DEFAULT_WEB_PUSH_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_WEB_PUSH_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  tag?: string;
  data?: {
    threadId?: string;
    url?: string;
    forceSystemNotification?: boolean;
    requiresDecision?: boolean;
  };
}

export interface PushNotificationServiceOptions {
  subscriptionStore: IPushSubscriptionStore;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

export interface PushDeliverySummary {
  attempted: number;
  delivered: number;
  failed: number;
  removed: number;
}

type PushSendOutcome = 'delivered' | 'removed';

export class PushNotificationService {
  private readonly store: IPushSubscriptionStore;
  private readonly proxy: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: PushNotificationServiceOptions) {
    this.store = opts.subscriptionStore;
    this.proxy = resolveWebPushProxy();
    this.timeoutMs = resolveWebPushTimeoutMs();
    webpush.setVapidDetails(opts.vapidSubject, opts.vapidPublicKey, opts.vapidPrivateKey);
  }

  /** Push to all subscribed devices (best-effort). */
  async notifyAll(payload: PushPayload): Promise<PushDeliverySummary> {
    const subs = await this.store.listAll();
    return this.sendToAll(subs, payload);
  }

  /** Push to a specific user's devices (best-effort). */
  async notifyUser(userId: string, payload: PushPayload): Promise<PushDeliverySummary> {
    const subs = await this.store.listByUser(userId);
    return this.sendToAll(subs, payload);
  }

  private async sendToAll(subs: PushSubscriptionRecord[], payload: PushPayload): Promise<PushDeliverySummary> {
    if (subs.length === 0) {
      return { attempted: 0, delivered: 0, failed: 0, removed: 0 };
    }

    const body = JSON.stringify(payload);
    const results = await Promise.allSettled(subs.map((sub) => this.sendOne(sub, body)));

    const summary: PushDeliverySummary = {
      attempted: subs.length,
      delivered: 0,
      failed: 0,
      removed: 0,
    };

    for (const r of results) {
      if (r.status === 'fulfilled') {
        if (r.value === 'removed') {
          summary.removed += 1;
        } else {
          summary.delivered += 1;
        }
        continue;
      }
      summary.failed += 1;
      log.warn({ error: r.reason }, 'Push delivery failed');
    }

    return summary;
  }

  private async sendOne(sub: PushSubscriptionRecord, body: string): Promise<PushSendOutcome> {
    const pushSub: webpush.PushSubscription = {
      endpoint: sub.endpoint,
      keys: sub.keys,
    };
    const sendOptions: webpush.RequestOptions = {
      TTL: 60 * 60, // 1 hour TTL
      timeout: this.timeoutMs,
    };
    if (this.proxy) {
      sendOptions.proxy = this.proxy;
    }
    try {
      await webpush.sendNotification(pushSub, body, sendOptions);
      return 'delivered';
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      // 410 Gone or 404 = subscription expired, auto-cleanup
      if (statusCode === 410 || statusCode === 404) {
        log.info({ endpoint: sub.endpoint.slice(0, 60) }, 'Removing expired subscription');
        await this.store.remove(sub.endpoint);
        return 'removed';
      }
      throw err;
    }
  }
}

/** Singleton — initialized by index.ts, null if VAPID keys not configured. */
let pushServiceInstance: PushNotificationService | null = null;

export function initPushNotificationService(opts: PushNotificationServiceOptions): PushNotificationService {
  pushServiceInstance = new PushNotificationService(opts);
  return pushServiceInstance;
}

export function getPushNotificationService(): PushNotificationService | null {
  return pushServiceInstance;
}
