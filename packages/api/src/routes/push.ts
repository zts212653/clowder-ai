import type { FastifyPluginAsync } from 'fastify';
import webpush from 'web-push';
import { requireConnectorWriteOwner, resolveConnectorSessionUserId } from '../config/connector-secret-write-guards.js';
import { AuditEventTypes, getEventAuditLog } from '../domains/cats/services/orchestration/EventAuditLog.js';
import type { PushNotificationService } from '../domains/cats/services/push/PushNotificationService.js';
import type { IPushSubscriptionStore } from '../domains/cats/services/stores/ports/PushSubscriptionStore.js';
import { isLoopbackAddress } from '../utils/loopback-request.js';
import {
  describeEndpoint,
  type PushDeliverySnapshot,
  resolveUserId,
  subscribeSchema,
  summarizeTargets,
  toDeliverySummary,
  unsubscribeSchema,
} from './push-route-helpers.js';

export interface PushRoutesOptions {
  pushSubscriptionStore: IPushSubscriptionStore;
  pushService: PushNotificationService | null;
  vapidPublicKey: string;
  getPushService?: () => PushNotificationService | null;
  getVapidPublicKey?: () => string;
  auditLog?: {
    append(input: { type: string; threadId?: string; data: Record<string, unknown> }): Promise<unknown>;
  };
}

export const pushRoutes: FastifyPluginAsync<PushRoutesOptions> = async (app, opts) => {
  const { pushSubscriptionStore, pushService, vapidPublicKey } = opts;
  const auditLog = opts.auditLog ?? getEventAuditLog();
  const deliveryByUser = new Map<string, PushDeliverySnapshot>();

  function getCurrentPushService(): PushNotificationService | null {
    if (opts.getPushService) {
      return opts.getPushService();
    }
    return pushService;
  }

  function getCurrentVapidPublicKey(): string {
    return opts.getVapidPublicKey?.() ?? vapidPublicKey;
  }

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
    const currentVapidPublicKey = getCurrentVapidPublicKey();
    const currentPushService = getCurrentPushService();
    if (!currentVapidPublicKey || !currentPushService) {
      return { key: null, enabled: false };
    }
    return { key: currentVapidPublicKey, enabled: true };
  });

  // GET /api/push/status — 前端通知能力矩阵 + 设备订阅状态 + 最近投递结果
  app.get('/api/push/status', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (X-Cat-Cafe-User header)' };
    }

    const subscriptions = await pushSubscriptionStore.listByUser(userId);
    const currentVapidPublicKey = getCurrentVapidPublicKey();
    const currentPushService = getCurrentPushService();
    const capability = {
      enabled: Boolean(currentVapidPublicKey) && Boolean(currentPushService),
      vapidPublicKeyConfigured: Boolean(currentVapidPublicKey),
      pushServiceConfigured: Boolean(currentPushService),
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

  // POST /api/push/generate-vapid — owner-only one-shot keypair generation.
  app.post('/api/push/generate-vapid', async (request, reply) => {
    if (!isLoopbackAddress(request.ip)) {
      reply.status(403);
      return { error: 'VAPID key generation endpoint is loopback-only' };
    }

    const operator = resolveConnectorSessionUserId(request);
    if (!operator) {
      reply.status(401);
      return { error: 'Identity required (session cookie)' };
    }

    const ownerError = requireConnectorWriteOwner(operator);
    if (ownerError) {
      reply.status(ownerError.status);
      return { error: ownerError.error };
    }

    const keys = webpush.generateVAPIDKeys();
    await appendPushAudit(request, AuditEventTypes.CONFIG_UPDATED, {
      target: 'push-vapid-generate',
      keys: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
      operator,
    });
    return keys;
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

    const currentPushService = getCurrentPushService();
    if (!currentPushService) {
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

    const delivery = await currentPushService.notifyUser(userId, {
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
