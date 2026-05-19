// @ts-check

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { PushSubscriptionStore } from '../dist/domains/cats/services/stores/ports/PushSubscriptionStore.js';
import { pushRoutes } from '../dist/routes/push.js';

/**
 * @typedef {import('../src/domains/cats/services/push/PushNotificationService.js').PushPayload} PushPayload
 * @typedef {import('../src/domains/cats/services/push/PushNotificationService.js').PushDeliverySummary} PushDeliverySummary
 * @typedef {{
 *   notifyUser: (userId: string, payload: PushPayload) => Promise<PushDeliverySummary>;
 *   notifyAll: (payload: PushPayload) => Promise<PushDeliverySummary>;
 * }} PushServiceMock
 */

/**
 * @param {Partial<PushServiceMock>} [overrides]
 * @returns {PushServiceMock}
 */
function makePushService(overrides = {}) {
  const emptySummary = async () => ({ attempted: 0, delivered: 0, failed: 0, removed: 0 });
  return {
    notifyUser: emptySummary,
    notifyAll: emptySummary,
    ...overrides,
  };
}

const OWNER_ID = 'owner';
const ORIGINAL_OWNER_ID = process.env.DEFAULT_OWNER_USER_ID;

describe('push routes', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  /** @type {import('../src/domains/cats/services/stores/ports/PushSubscriptionStore.js').PushSubscriptionStore} */
  let store;
  /** @type {Array<{type:string,data:Record<string, unknown>}>} */
  let auditEvents;

  beforeEach(async () => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    store = new PushSubscriptionStore();
    auditEvents = [];
    const auditLog = {
      append: async (input) => {
        auditEvents.push({ type: input.type, data: input.data });
        return { id: 'audit-test-id' };
      },
    };
    app = Fastify();
    app.addHook('preHandler', async (request) => {
      const sessionUser = request.headers['x-test-session-user'];
      if (typeof sessionUser === 'string' && sessionUser.trim()) {
        request.sessionUserId = sessionUser.trim();
      }
    });
    await app.register(pushRoutes, {
      pushSubscriptionStore: store,
      pushService: null,
      vapidPublicKey: 'test-vapid-key-123',
      auditLog,
    });
    await app.ready();
  });

  afterEach(async () => {
    if (ORIGINAL_OWNER_ID === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = ORIGINAL_OWNER_ID;
    await app?.close();
  });

  it('GET /api/push/vapid-public-key returns key when pushService is configured', async () => {
    const appWithPush = Fastify();
    await appWithPush.register(pushRoutes, {
      pushSubscriptionStore: store,
      pushService: makePushService(), // mock
      vapidPublicKey: 'test-vapid-key-123',
      auditLog: {
        append: async (input) => {
          auditEvents.push({ type: input.type, data: input.data });
          return { id: 'audit-test-id' };
        },
      },
    });
    await appWithPush.ready();

    const res = await appWithPush.inject({
      method: 'GET',
      url: '/api/push/vapid-public-key',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.key, 'test-vapid-key-123');
    assert.equal(body.enabled, true);
  });

  it('GET /api/push/vapid-public-key returns null when no key', async () => {
    const app2 = Fastify();
    await app2.register(pushRoutes, {
      pushSubscriptionStore: store,
      pushService: null,
      vapidPublicKey: '',
      auditLog: {
        append: async (input) => {
          auditEvents.push({ type: input.type, data: input.data });
          return { id: 'audit-test-id' };
        },
      },
    });
    await app2.ready();

    const res = await app2.inject({
      method: 'GET',
      url: '/api/push/vapid-public-key',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.key, null);
    assert.equal(body.enabled, false);
  });

  it('GET /api/push/vapid-public-key returns disabled when pushService is null (partial config)', async () => {
    // Simulates: VAPID_PUBLIC_KEY set but VAPID_PRIVATE_KEY missing → pushService=null
    const app2 = Fastify();
    await app2.register(pushRoutes, {
      pushSubscriptionStore: store,
      pushService: null,
      vapidPublicKey: 'partial-key-only',
      auditLog: {
        append: async (input) => {
          auditEvents.push({ type: input.type, data: input.data });
          return { id: 'audit-test-id' };
        },
      },
    });
    await app2.ready();

    const res = await app2.inject({
      method: 'GET',
      url: '/api/push/vapid-public-key',
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.key, null, 'should not expose key when push is not fully configured');
    assert.equal(body.enabled, false);
  });

  it('GET /api/push/status and public key use live push config getters', async () => {
    /** @type {PushServiceMock | null} */
    let currentPushService = null;
    let currentVapidPublicKey = '';
    const appWithLiveConfig = Fastify();
    await appWithLiveConfig.register(pushRoutes, {
      pushSubscriptionStore: store,
      pushService: null,
      vapidPublicKey: '',
      getPushService: () => currentPushService,
      getVapidPublicKey: () => currentVapidPublicKey,
      auditLog: {
        append: async (input) => {
          auditEvents.push({ type: input.type, data: input.data });
          return { id: 'audit-test-id' };
        },
      },
    });
    await appWithLiveConfig.ready();

    const before = await appWithLiveConfig.inject({
      method: 'GET',
      url: '/api/push/status',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(before.statusCode, 200);
    assert.equal(JSON.parse(before.payload).capability.enabled, false);

    currentPushService = makePushService();
    currentVapidPublicKey = 'live-vapid-public-key';

    const statusRes = await appWithLiveConfig.inject({
      method: 'GET',
      url: '/api/push/status',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(statusRes.statusCode, 200);
    const statusBody = JSON.parse(statusRes.payload);
    assert.equal(statusBody.capability.enabled, true);
    assert.equal(statusBody.capability.vapidPublicKeyConfigured, true);
    assert.equal(statusBody.capability.pushServiceConfigured, true);

    const keyRes = await appWithLiveConfig.inject({
      method: 'GET',
      url: '/api/push/vapid-public-key',
    });
    assert.equal(keyRes.statusCode, 200);
    assert.deepEqual(JSON.parse(keyRes.payload), { key: 'live-vapid-public-key', enabled: true });
    await appWithLiveConfig.close();
  });

  it('GET /api/push/status and POST /api/push/test preserve live getter null over startup service', async () => {
    store.upsert({
      endpoint: 'https://push.example.com/sub/live-disabled',
      keys: { p256dh: 'key1', auth: 'auth1' },
      userId: 'owner',
      createdAt: Date.now(),
    });

    let notifyCalled = false;
    const startupPushService = makePushService({
      notifyUser: async () => {
        notifyCalled = true;
        return { attempted: 1, delivered: 1, failed: 0, removed: 0 };
      },
    });
    const appWithLiveConfig = Fastify();
    await appWithLiveConfig.register(pushRoutes, {
      pushSubscriptionStore: store,
      pushService: startupPushService,
      vapidPublicKey: 'startup-vapid-public-key',
      getPushService: () => null,
      getVapidPublicKey: () => 'live-vapid-public-key',
      auditLog: {
        append: async (input) => {
          auditEvents.push({ type: input.type, data: input.data });
          return { id: 'audit-test-id' };
        },
      },
    });
    await appWithLiveConfig.ready();

    const statusRes = await appWithLiveConfig.inject({
      method: 'GET',
      url: '/api/push/status',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(statusRes.statusCode, 200);
    const statusBody = JSON.parse(statusRes.payload);
    assert.equal(statusBody.capability.enabled, false);
    assert.equal(statusBody.capability.vapidPublicKeyConfigured, true);
    assert.equal(statusBody.capability.pushServiceConfigured, false);
    assert.equal(statusBody.errorHints.includes('push_not_configured'), true);

    const testRes = await appWithLiveConfig.inject({
      method: 'POST',
      url: '/api/push/test',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(testRes.statusCode, 503);
    assert.equal(notifyCalled, false, 'startup push service must not be used after live config disables push');
    await appWithLiveConfig.close();
  });

  it('POST /api/push/generate-vapid fails closed when DEFAULT_OWNER_USER_ID is missing', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/generate-vapid',
      headers: { 'x-test-session-user': OWNER_ID },
    });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /DEFAULT_OWNER_USER_ID/);
    assert.equal(auditEvents.length, 0);
  });

  it('POST /api/push/generate-vapid rejects trusted header identity without a real session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/generate-vapid',
      headers: { 'x-cat-cafe-user': OWNER_ID },
    });
    assert.equal(res.statusCode, 401);
    assert.match(JSON.parse(res.payload).error, /Identity required/);
  });

  it('POST /api/push/generate-vapid rejects non-loopback clients before returning key material', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/generate-vapid',
      headers: { 'x-test-session-user': OWNER_ID },
      remoteAddress: '203.0.113.10',
    });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.payload).error, /loopback-only/);
    assert.equal(auditEvents.length, 0);
  });

  it('POST /api/push/generate-vapid returns keys to owner and audits metadata only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/generate-vapid',
      headers: { 'x-test-session-user': OWNER_ID },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(typeof body.publicKey, 'string');
    assert.equal(typeof body.privateKey, 'string');
    assert.ok(body.publicKey.length > 20);
    assert.ok(body.privateKey.length > 20);

    const auditJson = JSON.stringify(auditEvents);
    assert.match(auditJson, /push-vapid-generate/);
    assert.match(auditJson, /VAPID_PUBLIC_KEY/);
    assert.doesNotMatch(auditJson, new RegExp(body.publicKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(auditJson, new RegExp(body.privateKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('GET /api/push/status requires auth', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/push/status',
    });
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /Identity required/i);
  });

  it('GET /api/push/status returns capability matrix + subscription summary', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/push/status',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);

    assert.equal(body.capability.enabled, false);
    assert.equal(body.capability.vapidPublicKeyConfigured, true);
    assert.equal(body.capability.pushServiceConfigured, false);
    assert.equal(body.subscription.count, 0);
    assert.equal(Array.isArray(body.subscription.targets), true);
    assert.equal(body.subscription.targets.length, 0);
    assert.equal(body.delivery.lastResult, 'not_attempted');
    assert.equal(Array.isArray(body.errorHints), true);
    assert.equal(body.errorHints.includes('push_not_configured'), true);
  });

  it('GET /api/push/status includes last delivery after successful test push', async () => {
    store.upsert({
      endpoint: 'https://push.example.com/sub/1',
      keys: { p256dh: 'key1', auth: 'auth1' },
      userId: 'owner',
      createdAt: Date.now(),
      userAgent: 'Chrome/123',
    });

    const notifyUser = async () => ({ attempted: 1, delivered: 1, failed: 0, removed: 0 });
    const appWithPush = Fastify();
    await appWithPush.register(pushRoutes, {
      pushSubscriptionStore: store,
      pushService: makePushService({ notifyUser }),
      vapidPublicKey: 'test-vapid-key-123',
      auditLog: {
        append: async (input) => {
          auditEvents.push({ type: input.type, data: input.data });
          return { id: 'audit-test-id' };
        },
      },
    });
    await appWithPush.ready();

    const testRes = await appWithPush.inject({
      method: 'POST',
      url: '/api/push/test',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(testRes.statusCode, 200);

    const statusRes = await appWithPush.inject({
      method: 'GET',
      url: '/api/push/status',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(statusRes.statusCode, 200);
    const body = JSON.parse(statusRes.payload);
    assert.equal(body.capability.enabled, true);
    assert.equal(body.subscription.count, 1);
    assert.equal(body.delivery.lastResult, 'ok');
    assert.equal(body.delivery.lastHttpStatus, 200);
    assert.equal(body.delivery.lastError, null);
    assert.equal(body.errorHints.length, 0);
  });

  it('POST /api/push/subscribe requires auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      payload: {
        subscription: {
          endpoint: 'https://push.example.com/sub/1',
          keys: { p256dh: 'key1', auth: 'auth1' },
        },
      },
    });
    assert.equal(res.statusCode, 401);
  });

  it('POST /api/push/subscribe stores subscription', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        subscription: {
          endpoint: 'https://push.example.com/sub/1',
          keys: { p256dh: 'key1', auth: 'auth1' },
        },
        userAgent: 'TestAgent',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'ok');
    assert.equal(body.deduplicatedByUserAgent, 0);
    assert.equal(store.listAll().length, 1);
    assert.equal(store.listAll()[0].userAgent, 'TestAgent');
  });

  it('POST /api/push/subscribe deduplicates older subscriptions with same userAgent', async () => {
    store.upsert({
      endpoint: 'https://push.example.com/sub/old',
      keys: { p256dh: 'old-key', auth: 'old-auth' },
      userId: 'owner',
      createdAt: Date.now() - 1000,
      userAgent: 'TestAgent',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        subscription: {
          endpoint: 'https://push.example.com/sub/new',
          keys: { p256dh: 'new-key', auth: 'new-auth' },
        },
        userAgent: 'TestAgent',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.status, 'ok');
    assert.equal(body.deduplicatedByUserAgent, 1);
    const all = store.listAll();
    assert.equal(all.length, 1);
    assert.equal(all[0].endpoint, 'https://push.example.com/sub/new');
  });

  it('POST /api/push/subscribe validates endpoint URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/subscribe',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {
        subscription: {
          endpoint: 'not-a-url',
          keys: { p256dh: 'key1', auth: 'auth1' },
        },
      },
    });
    assert.equal(res.statusCode, 400);
  });

  it('DELETE /api/push/subscribe removes own subscription', async () => {
    store.upsert({
      endpoint: 'https://push.example.com/sub/1',
      keys: { p256dh: 'key1', auth: 'auth1' },
      userId: 'owner',
      createdAt: Date.now(),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/push/subscribe',
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: { endpoint: 'https://push.example.com/sub/1' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.removed, true);
    assert.equal(store.listAll().length, 0);
  });

  it('DELETE /api/push/subscribe rejects when user does not own subscription', async () => {
    store.upsert({
      endpoint: 'https://push.example.com/sub/1',
      keys: { p256dh: 'key1', auth: 'auth1' },
      userId: 'owner',
      createdAt: Date.now(),
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/push/subscribe',
      headers: { 'x-cat-cafe-user': 'intruder' },
      payload: { endpoint: 'https://push.example.com/sub/1' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(store.listAll().length, 1, 'subscription should remain intact');
  });

  it('POST /api/push/test returns 503 when push not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/push/test',
      headers: { 'x-cat-cafe-user': 'owner' },
    });
    assert.equal(res.statusCode, 503);
  });

  it('POST /api/push/test returns 409 when user has no active subscriptions', async () => {
    const notifyUser = () => {};
    const appWithPush = Fastify();
    await appWithPush.register(pushRoutes, {
      pushSubscriptionStore: store,
      pushService: makePushService({ notifyUser }),
      vapidPublicKey: 'test-vapid-key-123',
      auditLog: {
        append: async (input) => {
          auditEvents.push({ type: input.type, data: input.data });
          return { id: 'audit-test-id' };
        },
      },
    });
    await appWithPush.ready();

    const res = await appWithPush.inject({
      method: 'POST',
      url: '/api/push/test',
      headers: { 'x-cat-cafe-user': 'owner' },
    });

    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /No active push subscription/i);
    assert.equal(body.deliverySummary.attempted, 0);
    assert.equal(body.deliverySummary.delivered, 0);
    assert.equal(body.deliverySummary.failed, 0);
    assert.equal(body.deliverySummary.removed, 0);
    assert.equal(
      auditEvents.some((event) => event.type === 'push_test_result' && event.data.error === 'no_active_subscription'),
      true,
    );
  });

  it('POST /api/push/test sends when user has active subscriptions', async () => {
    store.upsert({
      endpoint: 'https://push.example.com/sub/1',
      keys: { p256dh: 'key1', auth: 'auth1' },
      userId: 'owner',
      createdAt: Date.now(),
    });

    let called = false;
    const notifyUser = async (userId, payload) => {
      called = true;
      assert.equal(userId, 'owner');
      assert.equal(payload.tag, 'push-test');
      assert.equal(payload.data?.forceSystemNotification, true);
      return { attempted: 1, delivered: 1, failed: 0, removed: 0 };
    };

    const appWithPush = Fastify();
    await appWithPush.register(pushRoutes, {
      pushSubscriptionStore: store,
      pushService: makePushService({ notifyUser }),
      vapidPublicKey: 'test-vapid-key-123',
      auditLog: {
        append: async (input) => {
          auditEvents.push({ type: input.type, data: input.data });
          return { id: 'audit-test-id' };
        },
      },
    });
    await appWithPush.ready();

    const res = await appWithPush.inject({
      method: 'POST',
      url: '/api/push/test',
      headers: { 'x-cat-cafe-user': 'owner' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(called, true);
    const body = JSON.parse(res.payload);
    assert.match(body.message, /系统通知已请求发送/);
    assert.equal(body.delivery.delivered, 1);
    assert.equal(body.deliverySummary.delivered, 1);
    assert.equal(body.deliverySummary.failed, 0);
    assert.equal(body.deliverySummary.removed, 0);
    assert.equal(Array.isArray(body.targets), true);
    assert.equal(body.targets.length, 1);
    assert.match(String(body.targets[0].endpoint), /push\.example\.com/);
    assert.equal(
      auditEvents.some((event) => event.type === 'push_test_result' && event.data.ok === true),
      true,
    );
  });

  it('POST /api/push/test returns 502 when push delivery fails', async () => {
    store.upsert({
      endpoint: 'https://push.example.com/sub/1',
      keys: { p256dh: 'key1', auth: 'auth1' },
      userId: 'owner',
      createdAt: Date.now(),
    });

    const notifyUser = async () => ({ attempted: 1, delivered: 0, failed: 1, removed: 0 });

    const appWithPush = Fastify();
    await appWithPush.register(pushRoutes, {
      pushSubscriptionStore: store,
      pushService: makePushService({ notifyUser }),
      vapidPublicKey: 'test-vapid-key-123',
      auditLog: {
        append: async (input) => {
          auditEvents.push({ type: input.type, data: input.data });
          return { id: 'audit-test-id' };
        },
      },
    });
    await appWithPush.ready();

    const res = await appWithPush.inject({
      method: 'POST',
      url: '/api/push/test',
      headers: { 'x-cat-cafe-user': 'owner' },
    });

    assert.equal(res.statusCode, 502);
    const body = JSON.parse(res.payload);
    assert.match(body.error, /投递失败|proxy|网络/i);
    assert.equal(body.delivery.delivered, 0);
    assert.equal(body.deliverySummary.attempted, 1);
    assert.equal(body.deliverySummary.delivered, 0);
    assert.equal(body.deliverySummary.failed, 1);
    assert.equal(body.deliverySummary.removed, 0);
    assert.equal(Array.isArray(body.targets), true);
    assert.equal(body.targets.length, 1);
    assert.equal(
      auditEvents.some((event) => event.type === 'push_test_result' && event.data.error === 'push_delivery_failed'),
      true,
    );
  });
});
