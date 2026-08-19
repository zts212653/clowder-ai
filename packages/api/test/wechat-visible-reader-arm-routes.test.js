import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import Fastify from 'fastify';
import { registerWeChatVisibleReaderArmRoutes } from '../dist/plugins/wechat-visible-reader/routes.js';
import { WeChatVisibleReaderArmStore } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderArmStore.js';
import { WeChatVisibleReaderMetrics } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderMetrics.js';
import { registerPluginRoutes } from '../dist/routes/plugin-routes.js';

const localHeaders = {
  host: 'localhost:3102',
  origin: 'http://localhost:5102',
  'x-test-session-user': 'owner-user',
};

function makeApp({ armStore, metrics = new WeChatVisibleReaderMetrics(), isPluginEnabled = () => true }) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
  });
  registerWeChatVisibleReaderArmRoutes(app, { armStore, metrics, isPluginEnabled });
  return app;
}

describe('WeChatVisibleReaderArmStore', () => {
  it('is ephemeral, replaces an existing arm, expires, and revokes without extending on read', () => {
    let now = Date.parse('2026-07-17T04:00:00.000Z');
    const store = new WeChatVisibleReaderArmStore({ now: () => now });

    assert.deepEqual(store.status(), { armed: false, remainingMs: 0 });
    assert.equal(store.isArmed(), false);

    const first = store.arm({ operator: 'owner-user', minutes: 10 });
    assert.equal(first.armed, true);
    assert.equal(first.armedBy, 'owner-user');
    assert.equal(first.remainingMs, 600_000);

    now += 60_000;
    assert.equal(store.status().remainingMs, 540_000);
    const replacement = store.arm({ operator: 'owner-user', minutes: 2 });
    assert.equal(replacement.remainingMs, 120_000);

    now += 120_001;
    assert.deepEqual(store.status(), { armed: false, remainingMs: 0 });
    assert.equal(store.isArmed(), false);

    store.arm({ operator: 'owner-user', minutes: 1 });
    store.disarm();
    assert.deepEqual(store.status(), { armed: false, remainingMs: 0 });
  });

  it('rejects invalid TTLs and never mutates state', () => {
    const store = new WeChatVisibleReaderArmStore();
    for (const minutes of [0, 31, 1.5, Number.NaN]) {
      assert.throws(() => store.arm({ operator: 'owner-user', minutes }), /whole number between 1 and 30/);
    }
    assert.equal(store.isArmed(), false);
  });
});

describe('WeChat visible reader arm routes', () => {
  const originalOwner = process.env.DEFAULT_OWNER_USER_ID;

  beforeEach(() => {
    process.env.DEFAULT_OWNER_USER_ID = 'owner-user';
  });

  afterEach(() => {
    if (originalOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = originalOwner;
  });

  it('lets a direct-local owner arm, inspect, and revoke the enabled plugin', async () => {
    let now = Date.parse('2026-07-17T04:00:00.000Z');
    const store = new WeChatVisibleReaderArmStore({ now: () => now });
    const app = makeApp({ armStore: store });
    await app.ready();
    try {
      const initial = await app.inject({
        method: 'GET',
        url: '/api/plugins/wechat-visible-reader/arm',
        headers: localHeaders,
        remoteAddress: '127.0.0.1',
      });
      assert.equal(initial.statusCode, 200, initial.payload);
      assert.deepEqual(initial.json(), {
        enabled: true,
        armed: false,
        remainingMs: 0,
        metrics: {
          totalReadAttempts: 0,
          totalSuccesses: 0,
          typedErrors: {},
          recentWindowSize: 0,
          recentSuccessRate: null,
          layoutPauseRecommended: false,
        },
      });

      const armed = await app.inject({
        method: 'POST',
        url: '/api/plugins/wechat-visible-reader/arm',
        headers: { ...localHeaders, 'content-type': 'application/json' },
        remoteAddress: '127.0.0.1',
        payload: { minutes: 10 },
      });
      assert.equal(armed.statusCode, 200, armed.payload);
      assert.equal(armed.json().armed, true);
      assert.equal(armed.json().remainingMs, 600_000);

      now += 1_000;
      const status = await app.inject({
        method: 'GET',
        url: '/api/plugins/wechat-visible-reader/arm',
        headers: localHeaders,
        remoteAddress: '127.0.0.1',
      });
      assert.equal(status.json().remainingMs, 599_000);

      const revoked = await app.inject({
        method: 'DELETE',
        url: '/api/plugins/wechat-visible-reader/arm',
        headers: localHeaders,
        remoteAddress: '127.0.0.1',
      });
      assert.equal(revoked.statusCode, 200, revoked.payload);
      assert.deepEqual(revoked.json(), { enabled: true, armed: false, remainingMs: 0 });
    } finally {
      await app.close();
    }
  });

  it('fails closed while the plugin is disabled and clears stale authorization', async () => {
    const store = new WeChatVisibleReaderArmStore();
    store.arm({ operator: 'owner-user', minutes: 10 });
    const app = makeApp({ armStore: store, isPluginEnabled: () => false });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/plugins/wechat-visible-reader/arm',
        headers: { ...localHeaders, 'content-type': 'application/json' },
        remoteAddress: '127.0.0.1',
        payload: { minutes: 10 },
      });
      assert.equal(response.statusCode, 409, response.payload);
      assert.equal(store.isArmed(), false);
    } finally {
      await app.close();
    }
  });

  it('rejects missing sessions, non-owner sessions, remote clients, and forwarded requests', async () => {
    const store = new WeChatVisibleReaderArmStore();
    const app = makeApp({ armStore: store });
    await app.ready();
    try {
      const cases = [
        {
          expected: 401,
          headers: { host: 'localhost:3102', origin: 'http://localhost:5102' },
          remoteAddress: '127.0.0.1',
        },
        {
          expected: 403,
          headers: { ...localHeaders, 'x-test-session-user': 'member-user' },
          remoteAddress: '127.0.0.1',
        },
        { expected: 403, headers: localHeaders, remoteAddress: '203.0.113.10' },
        {
          expected: 403,
          headers: { ...localHeaders, 'x-forwarded-for': '203.0.113.10' },
          remoteAddress: '127.0.0.1',
        },
      ];
      for (const testCase of cases) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/plugins/wechat-visible-reader/arm',
          headers: { ...testCase.headers, 'content-type': 'application/json' },
          remoteAddress: testCase.remoteAddress,
          payload: { minutes: 10 },
        });
        assert.equal(response.statusCode, testCase.expected, response.payload);
      }
      assert.equal(store.isArmed(), false);
    } finally {
      await app.close();
    }
  });

  it('rejects malformed TTLs without changing authorization', async () => {
    const store = new WeChatVisibleReaderArmStore();
    const app = makeApp({ armStore: store });
    await app.ready();
    try {
      for (const payload of [{}, { minutes: 0 }, { minutes: 31 }, { minutes: 1.5 }, { minutes: '10' }]) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/plugins/wechat-visible-reader/arm',
          headers: { ...localHeaders, 'content-type': 'application/json' },
          remoteAddress: '127.0.0.1',
          payload,
        });
        assert.equal(response.statusCode, 400, response.payload);
      }
      assert.equal(store.isArmed(), false);
    } finally {
      await app.close();
    }
  });

  it('clears authorization when the Fastify runtime closes', async () => {
    const store = new WeChatVisibleReaderArmStore();
    const app = makeApp({ armStore: store });
    await app.ready();
    store.arm({ operator: 'owner-user', minutes: 10 });

    await app.close();

    assert.equal(store.isArmed(), false);
  });

  it('runs the sensitive lifecycle hook before generic plugin disablement', async () => {
    const store = new WeChatVisibleReaderArmStore();
    store.arm({ operator: 'owner-user', minutes: 10 });
    const manifest = {
      id: 'wechat-visible-reader',
      name: 'WeChat visible reader',
      version: '1.0.0',
      config: [],
      resources: [],
    };
    let disableObservedArmed = true;
    const app = Fastify();
    app.addHook('preHandler', async (request) => {
      const raw = request.headers['x-test-session-user'];
      if (typeof raw === 'string' && raw.trim()) request.sessionUserId = raw.trim();
    });
    registerPluginRoutes(app, {
      pluginRegistry: {
        scan: () => [manifest],
        getManifest: () => manifest,
      },
      pluginActivator: {
        disablePlugin: async () => {
          disableObservedArmed = store.isArmed();
          return { status: 'success', resources: [] };
        },
      },
      limbRegistry: {},
      pluginsDir: '/tmp/plugins',
      beforePluginDisable: (pluginId) => {
        if (pluginId === 'wechat-visible-reader') store.disarm();
      },
    });
    await app.ready();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/plugins/wechat-visible-reader/disable',
        headers: localHeaders,
        remoteAddress: '127.0.0.1',
      });

      assert.equal(response.statusCode, 200, response.payload);
      assert.equal(disableObservedArmed, false);
      assert.equal(store.isArmed(), false);
    } finally {
      await app.close();
    }
  });
});
