import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

const { connectorHubRoutes } = await import('../dist/routes/connector-hub.js');

const AUTH_HEADERS = { 'x-cat-cafe-user': 'owner-1' };

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

describe('Feishu QR routes', () => {
  it('POST /api/connector/feishu/qrcode returns QR image and payload', async () => {
    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      feishuRegistrationFetch: async (_url, init) => {
        const form = new URLSearchParams(String(init?.body ?? ''));
        const action = form.get('action');
        if (action === 'init') {
          return jsonResponse({ supported_auth_methods: ['client_secret'] });
        }
        if (action === 'begin') {
          return jsonResponse({
            verification_uri_complete: 'https://accounts.feishu.cn/oauth/verify?token=abc',
            device_code: 'device-abc',
            interval: 5,
            expire_in: 600,
          });
        }
        return jsonResponse({ error: 'unexpected_action' }, 400);
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/feishu/qrcode',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.qrPayload, 'device-abc');
    assert.ok(typeof body.qrUrl === 'string' && body.qrUrl.startsWith('data:image/png;base64,'));
    assert.equal(body.interval, 5);
    assert.equal(body.expiresIn, 600);

    await app.close();
  });

  it('GET /api/connector/feishu/qrcode-status persists credentials to env file on confirm', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-feishu-qr-'));
    const envFilePath = join(tempRoot, '.env');
    writeFileSync(envFilePath, '', 'utf8');

    const originalEnv = {
      FEISHU_APP_ID: process.env.FEISHU_APP_ID,
      FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
      FEISHU_CONNECTION_MODE: process.env.FEISHU_CONNECTION_MODE,
    };

    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
      feishuRegistrationFetch: async (_url, init) => {
        const form = new URLSearchParams(String(init?.body ?? ''));
        const action = form.get('action');
        if (action === 'poll') {
          return jsonResponse({
            client_id: 'cli_test_app_id',
            client_secret: 'test_app_secret_123',
            user_info: { open_id: 'ou_test', tenant_brand: 'feishu' },
          });
        }
        return jsonResponse({ error: 'unexpected_action' }, 400);
      },
    });
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/connector/feishu/qrcode-status?qrPayload=device-xyz',
        headers: AUTH_HEADERS,
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).status, 'confirmed');

      const envText = readFileSync(envFilePath, 'utf8');
      assert.match(envText, /FEISHU_APP_ID=cli_test_app_id/);
      assert.match(envText, /FEISHU_APP_SECRET=test_app_secret_123/);
      assert.match(envText, /FEISHU_CONNECTION_MODE=websocket/);
    } finally {
      if (originalEnv.FEISHU_APP_ID == null) delete process.env.FEISHU_APP_ID;
      else process.env.FEISHU_APP_ID = originalEnv.FEISHU_APP_ID;
      if (originalEnv.FEISHU_APP_SECRET == null) delete process.env.FEISHU_APP_SECRET;
      else process.env.FEISHU_APP_SECRET = originalEnv.FEISHU_APP_SECRET;
      if (originalEnv.FEISHU_CONNECTION_MODE == null) delete process.env.FEISHU_CONNECTION_MODE;
      else process.env.FEISHU_CONNECTION_MODE = originalEnv.FEISHU_CONNECTION_MODE;
      await app.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
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
