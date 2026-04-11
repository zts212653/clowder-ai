/**
 * Push Notification Routes — Web Push 订阅管理
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import type { PushNotificationService } from '../domains/cats/services/push/PushNotificationService.js';
import type {
  IPushSubscriptionStore,
  PushSubscriptionRecord,
} from '../domains/cats/services/stores/ports/PushSubscriptionStore.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

export interface PushRoutesOptions {
  pushSubscriptionStore: IPushSubscriptionStore;
  pushService: PushNotificationService | null;
  vapidPublicKey: string;
  auditLog?: {
    append(input: { type: string; threadId?: string; data: Record<string, unknown> }): Promise<unknown>;
  };
}

type PushDeliveryStatus = 'ok' | 'error' | 'not_attempted';

interface PushDeliverySnapshot {
  lastAttemptAt: number | null;
  lastHttpStatus: number | null;
  lastResult: PushDeliveryStatus;
  lastError: string | null;
}

interface PushDeliverySummary {
  attempted: number;
  delivered: number;
  failed: number;
  removed: number;
}

function resolveUserId(request: import('fastify').FastifyRequest): string | null {
  return resolveHeaderUserId(request);
}

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({
      p256dh: z.string().min(1),
      auth: z.string().min(1),
    }),
  }),
  userAgent: z.string().max(500).optional(),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export const pushRoutes: FastifyPluginAsync<PushRoutesOptions> = async (app, opts) => {
  const { pushSubscriptionStore, pushService, vapidPublicKey } = opts;
  const auditLog = opts.auditLog ?? getEventAuditLog();
  const deliveryByUser = new Map<string, PushDeliverySnapshot>();

  function getDeliverySnapshot(userId: string): PushDeliverySnapshot {
    return (
      deliveryByUser.get(userId) ?? {
        lastAttemptAt: null,
        lastHttpStatus: null,
        lastResult: 'not_attempted',
        lastError: null,
      }
    );
  }

  function setDeliverySnapshot(userId: string, update: PushDeliverySnapshot): void {
    deliveryByUser.set(userId, update);
  }

  function toDeliverySummary(delivery: Partial<PushDeliverySummary> | null | undefined): PushDeliverySummary {
    return {
      attempted: delivery?.attempted ?? 0,
      delivered: delivery?.delivered ?? 0,
      failed: delivery?.failed ?? 0,
      removed: delivery?.removed ?? 0,
    };
  }

  function describeEndpoint(endpoint: string): string {
    try {
      const url = new URL(endpoint);
      return `${url.host}...${endpoint.slice(-12)}`;
    } catch {
      return `invalid...${endpoint.slice(-12)}`;
    }
  }

  function summarizeUserAgent(userAgent?: string): string {
    if (!userAgent) return 'unknown';
    if (userAgent.includes('Edg/')) return 'edge';
    if (userAgent.includes('Chrome/')) return 'chrome';
    if (userAgent.includes('Firefox/')) return 'firefox';
    if (userAgent.includes('Safari/')) return 'safari';
    return 'other';
  }

  function summarizeTargets(subscriptions: PushSubscriptionRecord[]): Array<Record<string, unknown>> {
    return subscriptions.map((sub) => ({
      endpoint: describeEndpoint(sub.endpoint),
      createdAt: sub.createdAt,
      uaFamily: summarizeUserAgent(sub.userAgent),
    }));
  }

  async function appendPushAudit(
    request: { log: { warn: (obj: unknown, msg?: string) => void } },
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    try {
      await auditLog.append({ type, data });
    } catch (err) {
      request.log.warn({ err, type }, 'push audit append failed');
    }
  }

  // GET /api/push/vapid-public-key — 前端获取 VAPID 公钥
  // enabled = pushService is fully configured (both VAPID keys present)
  app.get('/api/push/vapid-public-key', async () => {
    if (!vapidPublicKey || !pushService) {
      return { key: null, enabled: false };
    }
    return { key: vapidPublicKey, enabled: true };
  });

  // GET /api/push/status — 前端通知能力矩阵 + 设备订阅状态 + 最近投递结果
  app.get('/api/push/status', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const subscriptions = await pushSubscriptionStore.listByUser(userId);
    const capability = {
      enabled: Boolean(vapidPublicKey) && Boolean(pushService),
      vapidPublicKeyConfigured: Boolean(vapidPublicKey),
      pushServiceConfigured: Boolean(pushService),
    };
    const delivery = getDeliverySnapshot(userId);
    const errorHints: string[] = [];
    if (!capability.vapidPublicKeyConfigured) errorHints.push('push_vapid_key_missing');
    if (!capability.pushServiceConfigured) errorHints.push('push_not_configured');
    if (subscriptions.length === 0) errorHints.push('push_subscription_missing');
    if (delivery.lastResult === 'error') errorHints.push('push_last_delivery_failed');

    return {
      capability,
      subscription: {
        count: subscriptions.length,
        targets: summarizeTargets(subscriptions),
      },
      delivery,
      errorHints,
    };
  });

  // POST /api/push/subscribe — 注册推送订阅
  app.post('/api/push/subscribe', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parsed = subscribeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid subscription', details: parsed.error.issues };
    }

    const { subscription, userAgent } = parsed.data;
    let deduplicatedByUserAgent = 0;
    if (userAgent) {
      const existing = await pushSubscriptionStore.listByUser(userId);
      for (const record of existing) {
        if (record.endpoint === subscription.endpoint) continue;
        if (record.userAgent !== userAgent) continue;
        if (await pushSubscriptionStore.removeForUser(userId, record.endpoint)) {
          deduplicatedByUserAgent += 1;
        }
      }
    }

    await pushSubscriptionStore.upsert({
      endpoint: subscription.endpoint,
      keys: subscription.keys,
      userId,
      createdAt: Date.now(),
      ...(userAgent ? { userAgent } : {}),
    });
    await appendPushAudit(request, AuditEventTypes.PUSH_SUBSCRIPTION_UPSERTED, {
      userId,
      endpoint: describeEndpoint(subscription.endpoint),
      hasUserAgent: Boolean(userAgent),
      deduplicatedByUserAgent,
    });

    return { status: 'ok', deduplicatedByUserAgent };
  });

  // DELETE /api/push/subscribe — 取消推送订阅
  app.delete('/api/push/subscribe', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const parsed = unsubscribeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }

    const removed = await pushSubscriptionStore.removeForUser(userId, parsed.data.endpoint);
    if (!removed) {
      reply.status(404);
      return { error: 'Subscription not found or not owned by this user' };
    }
    await appendPushAudit(request, AuditEventTypes.PUSH_SUBSCRIPTION_REMOVED, {
      userId,
      endpoint: describeEndpoint(parsed.data.endpoint),
      removed,
    });
    return { status: 'ok', removed };
  });

  // POST /api/push/test — 调试用：给自己发测试推送
  app.post('/api/push/test', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }
    await appendPushAudit(request, AuditEventTypes.PUSH_TEST_REQUESTED, {
      userId,
      proxyConfigured: Boolean(
        process.env.HTTPS_PROXY ||
          process.env.https_proxy ||
          process.env.HTTP_PROXY ||
          process.env.http_proxy ||
          process.env.ALL_PROXY ||
          process.env.all_proxy,
      ),
    });

    if (!pushService) {
      reply.status(503);
      setDeliverySnapshot(userId, {
        lastAttemptAt: Date.now(),
        lastHttpStatus: 503,
        lastResult: 'error',
        lastError: 'push_not_configured',
      });
      await appendPushAudit(request, AuditEventTypes.PUSH_TEST_RESULT, {
        userId,
        ok: false,
        httpStatus: 503,
        error: 'push_not_configured',
      });
      return {
        error: 'Push not configured (missing VAPID keys)',
        deliverySummary: toDeliverySummary(null),
      };
    }

    const subscriptions = await pushSubscriptionStore.listByUser(userId);
    const targets = summarizeTargets(subscriptions);
    if (subscriptions.length === 0) {
      reply.status(409);
      setDeliverySnapshot(userId, {
        lastAttemptAt: Date.now(),
        lastHttpStatus: 409,
        lastResult: 'error',
        lastError: 'no_active_subscription',
      });
      await appendPushAudit(request, AuditEventTypes.PUSH_TEST_RESULT, {
        userId,
        ok: false,
        httpStatus: 409,
        error: 'no_active_subscription',
        subscriptions: 0,
      });
      return {
        error: 'No active push subscriptions for this user. Please enable push on this device first.',
        deliverySummary: toDeliverySummary(null),
      };
    }

    const delivery = await pushService.notifyUser(userId, {
      title: '🐱 猫猫测试推送',
      body: '如果你看到这条通知，说明推送配置成功了！',
      tag: 'push-test',
      data: { url: '/', forceSystemNotification: true },
    });

    if (delivery.delivered === 0) {
      reply.status(502);
      if (delivery.removed > 0 && delivery.failed === 0) {
        setDeliverySnapshot(userId, {
          lastAttemptAt: Date.now(),
          lastHttpStatus: 502,
          lastResult: 'error',
          lastError: 'subscription_expired',
        });
        await appendPushAudit(request, AuditEventTypes.PUSH_TEST_RESULT, {
          userId,
          ok: false,
          httpStatus: 502,
          error: 'subscription_expired',
          delivery,
          targets,
        });
        return {
          error: '该设备推送订阅已过期，请先关闭并重新开启推送后再试。',
          delivery,
          deliverySummary: toDeliverySummary(delivery),
          targets,
        };
      }
      setDeliverySnapshot(userId, {
        lastAttemptAt: Date.now(),
        lastHttpStatus: 502,
        lastResult: 'error',
        lastError: 'push_delivery_failed',
      });
      await appendPushAudit(request, AuditEventTypes.PUSH_TEST_RESULT, {
        userId,
        ok: false,
        httpStatus: 502,
        error: 'push_delivery_failed',
        delivery,
        targets,
      });
      return {
        error: '系统通知投递失败，请检查 API 代理/网络后重试。',
        delivery,
        deliverySummary: toDeliverySummary(delivery),
        targets,
      };
    }

    setDeliverySnapshot(userId, {
      lastAttemptAt: Date.now(),
      lastHttpStatus: 200,
      lastResult: 'ok',
      lastError: null,
    });
    await appendPushAudit(request, AuditEventTypes.PUSH_TEST_RESULT, {
      userId,
      ok: true,
      httpStatus: 200,
      delivery,
      targets,
    });

    return {
      status: 'ok',
      message: '系统通知已请求发送，请查看系统通知中心。',
      delivery,
      deliverySummary: toDeliverySummary(delivery),
      targets,
    };
  });
};
