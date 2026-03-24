import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { connectorHubRoutes } = await import('../dist/routes/connector-hub.js');

const AUTH_HEADERS = { 'x-cat-cafe-user': 'owner-1' };

async function buildApp(overrides = {}) {
  const listCalls = [];
  const threadStore = {
    async list(userId) {
      listCalls.push(userId);
      return (
        overrides.threads ?? [
          {
            id: 'thread-hub-2',
            title: 'Feishu IM Hub',
            connectorHubState: { connectorId: 'feishu', externalChatId: 'chat-2', createdAt: 20 },
          },
          {
            id: 'thread-normal',
            title: 'Regular thread',
            connectorHubState: null,
          },
          {
            id: 'thread-hub-1',
            title: 'Telegram IM Hub',
            connectorHubState: { connectorId: 'telegram', externalChatId: 'chat-1', createdAt: 10 },
          },
        ]
      );
    },
  };

  const app = Fastify();
  await app.register(connectorHubRoutes, { threadStore });
  await app.ready();
  return { app, listCalls };
}

describe('GET /api/connector/weixin/qrcode-status — adapter not ready', () => {
  it('P1: returns 503 when QR confirms but weixinAdapter is not available (cloud review a312a53f)', async () => {
    // Arrange: inject a mock fetch that makes pollQrCodeStatus return 'confirmed'
    const { WeixinAdapter: WA } = await import('../dist/infrastructure/connectors/adapters/WeixinAdapter.js');
    const originalFetch = globalThis.fetch;
    WA._injectStaticFetch(async () => ({
      ok: true,
      json: async () => ({ errcode: 0, status: 2, bot_token: 'tok_secret_123' }),
    }));

    const app = Fastify();
    // Register with weixinAdapter deliberately missing (simulates gateway not started)
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      weixinAdapter: undefined,
    });
    await app.ready();

    // Act
    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/weixin/qrcode-status?qrPayload=test-payload',
      headers: AUTH_HEADERS,
    });

    // Assert: should NOT return confirmed with 200 — token would be lost
    const body = JSON.parse(res.body);
    assert.notEqual(res.statusCode, 200, 'Should not return 200 when adapter is missing');
    assert.equal(res.statusCode, 503);
    assert.ok(body.error, 'Response should contain error message');
    assert.equal(body.status, undefined, 'Should not leak confirmed status');

    // Cleanup
    WA._injectStaticFetch(originalFetch);
    await app.close();
  });

  it('P1: returns confirmed when adapter IS available and QR confirms', async () => {
    const { WeixinAdapter: WA } = await import('../dist/infrastructure/connectors/adapters/WeixinAdapter.js');
    const originalFetch = globalThis.fetch;
    WA._injectStaticFetch(async () => ({
      ok: true,
      json: async () => ({ errcode: 0, status: 2, bot_token: 'tok_secret_456' }),
    }));

    let tokenSet = null;
    let pollingStarted = false;
    const mockAdapter = {
      setBotToken(t) {
        tokenSet = t;
      },
      hasBotToken() {
        return tokenSet != null;
      },
      isPolling() {
        return pollingStarted;
      },
    };

    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      weixinAdapter: mockAdapter,
      startWeixinPolling: () => {
        pollingStarted = true;
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/weixin/qrcode-status?qrPayload=test-payload',
      headers: AUTH_HEADERS,
    });

    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.status, 'confirmed');
    assert.equal(tokenSet, 'tok_secret_456', 'Token should be set on adapter');
    assert.equal(pollingStarted, true, 'Polling should be started');

    WA._injectStaticFetch(originalFetch);
    await app.close();
  });
});

describe('GET /api/connector/hub-threads', () => {
  it('returns 401 when only a spoofed userId query param is provided', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/hub-threads?userId=spoofed',
    });
    assert.equal(res.statusCode, 401);
    assert.match(JSON.parse(res.body).error, /Identity required/i);
  });

  it('uses the trusted header identity and returns hub threads sorted by createdAt desc', async () => {
    const { app, listCalls } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/hub-threads?userId=spoofed',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(listCalls, ['owner-1']);

    const body = JSON.parse(res.body);
    assert.deepEqual(
      body.threads.map((thread) => thread.id),
      ['thread-hub-2', 'thread-hub-1'],
    );
    assert.deepEqual(body.threads[0], {
      id: 'thread-hub-2',
      title: 'Feishu IM Hub',
      connectorId: 'feishu',
      externalChatId: 'chat-2',
      createdAt: 20,
    });
  });
});
