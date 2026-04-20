import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
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

describe('F134 follow-up — Feishu QR bind routes', () => {
  it('POST /api/connector/feishu/qrcode returns QR payload from bind client', async () => {
    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      feishuQrBindClient: {
        async create() {
          return {
            qrUrl: 'data:image/png;base64,abc',
            qrPayload: 'device-123',
            intervalMs: 5000,
            expireMs: 600000,
          };
        },
        async poll() {
          throw new Error('not used');
        },
      },
    });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/connector/feishu/qrcode', headers: AUTH_HEADERS });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.qrPayload, 'device-123');
    assert.equal(body.qrUrl, 'data:image/png;base64,abc');
    assert.equal(body.intervalMs, 5000);
    assert.equal(body.expireMs, 600000);
    await app.close();
  });

  it('GET /api/connector/feishu/qrcode-status persists credentials and auto-switches to websocket when webhook lacks verification token', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'feishu-qr-bind-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'FEISHU_CONNECTION_MODE=webhook\n');
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_VERIFICATION_TOKEN;
    process.env.FEISHU_CONNECTION_MODE = 'webhook';

    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
      feishuQrBindClient: {
        async create() {
          throw new Error('not used');
        },
        async poll() {
          return { status: 'confirmed', appId: 'cli_feishu', appSecret: 'sec_feishu' };
        },
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/feishu/qrcode-status?qrPayload=device-123',
      headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.status, 'confirmed');
    assert.equal(process.env.FEISHU_APP_ID, 'cli_feishu');
    assert.equal(process.env.FEISHU_APP_SECRET, 'sec_feishu');
    assert.equal(process.env.FEISHU_CONNECTION_MODE, 'websocket');

    const envText = readFileSync(envFilePath, 'utf8');
    assert.match(envText, /FEISHU_APP_ID=cli_feishu/);
    assert.match(envText, /FEISHU_APP_SECRET=sec_feishu/);
    assert.match(envText, /FEISHU_CONNECTION_MODE=websocket/);

    await app.close();
  });

  it('GET /api/connector/feishu/qrcode-status preserves explicit webhook mode when verification token exists', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'feishu-qr-bind-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'FEISHU_CONNECTION_MODE=webhook\nFEISHU_VERIFICATION_TOKEN=vt_123\n');
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_CONNECTION_MODE = 'webhook';
    process.env.FEISHU_VERIFICATION_TOKEN = 'vt_123';

    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
      feishuQrBindClient: {
        async create() {
          throw new Error('not used');
        },
        async poll() {
          return { status: 'confirmed', appId: 'cli_feishu_2', appSecret: 'sec_feishu_2' };
        },
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/feishu/qrcode-status?qrPayload=device-456',
      headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.status, 'confirmed');
    assert.equal(process.env.FEISHU_CONNECTION_MODE, 'webhook');
    assert.doesNotMatch(readFileSync(envFilePath, 'utf8'), /FEISHU_CONNECTION_MODE=websocket/);

    await app.close();
  });
});

describe('POST /api/connector/feishu/disconnect', () => {
  it('clears FEISHU_APP_ID and FEISHU_APP_SECRET via applyConnectorSecretUpdates and returns ok', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'feishu-disconnect-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'FEISHU_APP_ID=cli_old\nFEISHU_APP_SECRET=sec_old\nFEISHU_CONNECTION_MODE=websocket\n');
    process.env.FEISHU_APP_ID = 'cli_old';
    process.env.FEISHU_APP_SECRET = 'sec_old';
    process.env.FEISHU_CONNECTION_MODE = 'websocket';

    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
    });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/connector/feishu/disconnect', headers: AUTH_HEADERS });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(process.env.FEISHU_APP_ID, undefined);
    assert.equal(process.env.FEISHU_APP_SECRET, undefined);
    // Connection mode should NOT be cleared (user preference)
    assert.equal(process.env.FEISHU_CONNECTION_MODE, 'websocket');

    const envText = readFileSync(envFilePath, 'utf8');
    assert.doesNotMatch(envText, /FEISHU_APP_ID=/);
    assert.doesNotMatch(envText, /FEISHU_APP_SECRET=/);
    assert.match(envText, /FEISHU_CONNECTION_MODE=websocket/);

    await app.close();
  });

  it('returns 401 without auth header', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/connector/feishu/disconnect' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});

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

  it('P1: persists WEIXIN_BOT_TOKEN to .env on QR confirmation so restarts skip re-scan', async () => {
    const { WeixinAdapter: WA } = await import('../dist/infrastructure/connectors/adapters/WeixinAdapter.js');
    const originalFetch = globalThis.fetch;
    WA._injectStaticFetch(async () => ({
      ok: true,
      json: async () => ({ errcode: 0, status: 2, bot_token: 'tok_persist_789' }),
    }));

    const tmpDir = mkdtempSync(join(os.tmpdir(), 'weixin-qr-persist-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'SOME_OTHER_KEY=existing\n');

    const mockAdapter = {
      setBotToken() {},
      hasBotToken() {
        return true;
      },
      isPolling() {
        return false;
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
      startWeixinPolling: () => {},
      envFilePath,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/weixin/qrcode-status?qrPayload=test-payload',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'confirmed');

    // Key assertion: token must be persisted to .env for restart survival
    const envContent = readFileSync(envFilePath, 'utf8');
    assert.ok(
      envContent.includes('WEIXIN_BOT_TOKEN=tok_persist_789'),
      `Expected .env to contain WEIXIN_BOT_TOKEN=tok_persist_789 but got:\n${envContent}`,
    );
    // Original keys should be preserved
    assert.ok(envContent.includes('SOME_OTHER_KEY=existing'), 'Existing .env entries should be preserved');

    WA._injectStaticFetch(originalFetch);
    await app.close();
  });
});

describe('POST /api/connector/weixin/disconnect', () => {
  it('returns 401 without auth header', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/connector/weixin/disconnect' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('returns 503 when adapter is not available', async () => {
    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      weixinAdapter: undefined,
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/weixin/disconnect',
      headers: AUTH_HEADERS,
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  });

  it('calls disconnect on adapter and returns ok', async () => {
    let disconnected = false;
    const mockAdapter = {
      hasBotToken: () => true,
      isPolling: () => true,
      async disconnect() {
        disconnected = true;
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
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/weixin/disconnect',
      headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(disconnected, true, 'adapter.disconnect() must be called');
    await app.close();
  });

  it("P1: clears persisted WEIXIN_BOT_TOKEN from .env on disconnect so restart won't auto-reconnect", async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'weixin-disconnect-clear-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'SOME_KEY=keep\nWEIXIN_BOT_TOKEN=tok_old_abc\n');

    let disconnected = false;
    const mockAdapter = {
      hasBotToken: () => true,
      isPolling: () => true,
      async disconnect() {
        disconnected = true;
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
      envFilePath,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/weixin/disconnect',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(disconnected, true);

    // Key assertion: persisted token must be cleared from .env
    const envContent = readFileSync(envFilePath, 'utf8');
    assert.ok(
      !envContent.includes('WEIXIN_BOT_TOKEN'),
      `Expected .env to NOT contain WEIXIN_BOT_TOKEN after disconnect but got:\n${envContent}`,
    );
    // Other keys should survive
    assert.ok(envContent.includes('SOME_KEY=keep'), 'Other .env entries should be preserved');

    await app.close();
  });
});

describe('GET /api/connector/hub-threads', () => {
  it('returns 401 without trusted identity header', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/hub-threads',
    });
    assert.equal(res.statusCode, 401);
    assert.match(JSON.parse(res.body).error, /Identity required/i);
  });

  it('trusts localhost origin fallback and serves default-user hub threads', async () => {
    const { app, listCalls } = await buildApp({
      threads: [
        {
          id: 'thread-hub-browser',
          title: 'Browser IM Hub',
          connectorHubState: { connectorId: 'telegram', externalChatId: 'chat-browser', createdAt: 30 },
        },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/hub-threads',
      headers: { origin: 'http://localhost:3003' },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(listCalls, ['default-user']);
    const body = JSON.parse(res.body);
    assert.equal(body.threads.length, 1);
    assert.equal(body.threads[0].id, 'thread-hub-browser');
    await app.close();
  });

  it('uses the trusted header identity and returns hub threads sorted by createdAt desc', async () => {
    const { app, listCalls } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/hub-threads',
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

// ── F132 Phase E: WeCom Bot guided setup routes ──

const { WeComBotAdapter } = await import('../dist/infrastructure/connectors/adapters/WeComBotAdapter.js');

describe('GET /api/connector/status — WeCom Bot live health', () => {
  it('P1: shows configured=false when adapter getter returns null (not false green from env)', async () => {
    const savedBotId = process.env.WECOM_BOT_ID;
    const savedSecret = process.env.WECOM_BOT_SECRET;
    process.env.WECOM_BOT_ID = 'some-bot';
    process.env.WECOM_BOT_SECRET = 'some-secret';

    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      getWeComBotAdapter: () => null, // adapter stopped/not started
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/status',
      headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body);
    const wecomBot = body.platforms.find((p) => p.id === 'wecom-bot');

    assert.ok(wecomBot, 'wecom-bot platform must exist in status');
    assert.equal(wecomBot.configured, false, 'configured must be false when adapter is null, even with env vars set');

    process.env.WECOM_BOT_ID = savedBotId;
    process.env.WECOM_BOT_SECRET = savedSecret;
    if (!savedBotId) delete process.env.WECOM_BOT_ID;
    if (!savedSecret) delete process.env.WECOM_BOT_SECRET;
    await app.close();
  });
});

describe('POST /api/connector/wecom-bot/validate', () => {
  it('returns 401 without auth header', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/wecom-bot/validate',
      payload: { botId: 'bot1', secret: 'sec1' },
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('returns 400 when botId or secret is missing', async () => {
    const { app } = await buildApp();
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/connector/wecom-bot/validate',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ botId: 'bot1' }),
    });
    assert.equal(res1.statusCode, 400);

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/connector/wecom-bot/validate',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ secret: 'sec1' }),
    });
    assert.equal(res2.statusCode, 400);
    await app.close();
  });

  it('saves credentials and calls startWeComBotStream on success', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'wecom-validate-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'EXISTING=keep\n');

    // Mock validateCredentials to succeed without real WeCom connection
    const original = WeComBotAdapter.validateCredentials;
    WeComBotAdapter.validateCredentials = async () => ({ valid: true });

    let streamStarted = false;
    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
      startWeComBotStream: async () => {
        streamStarted = true;
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/wecom-bot/validate',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ botId: 'test-bot', secret: 'test-sec' }),
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.valid, true);
    assert.equal(streamStarted, true, 'startWeComBotStream must be called');
    assert.equal(process.env.WECOM_BOT_ID, 'test-bot');
    assert.equal(process.env.WECOM_BOT_SECRET, 'test-sec');

    const envContent = readFileSync(envFilePath, 'utf8');
    assert.match(envContent, /WECOM_BOT_ID=test-bot/);
    assert.match(envContent, /WECOM_BOT_SECRET=test-sec/);
    assert.match(envContent, /EXISTING=keep/);

    WeComBotAdapter.validateCredentials = original;
    delete process.env.WECOM_BOT_ID;
    delete process.env.WECOM_BOT_SECRET;
    await app.close();
  });

  it('P1: rolls back credentials when startWeComBotStream throws', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'wecom-rollback-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'OTHER=stay\n');

    const original = WeComBotAdapter.validateCredentials;
    WeComBotAdapter.validateCredentials = async () => ({ valid: true });

    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
      startWeComBotStream: async () => {
        throw new Error('SDK init failed');
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/wecom-bot/validate',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ botId: 'fail-bot', secret: 'fail-sec' }),
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 502);
    assert.equal(body.valid, false);
    assert.match(body.error, /adapter failed to start/);

    // Credentials must NOT remain in .env or process.env
    assert.equal(process.env.WECOM_BOT_ID, undefined, 'WECOM_BOT_ID must be rolled back');
    assert.equal(process.env.WECOM_BOT_SECRET, undefined, 'WECOM_BOT_SECRET must be rolled back');
    const envContent = readFileSync(envFilePath, 'utf8');
    assert.ok(!envContent.includes('WECOM_BOT_ID'), '.env must not contain WECOM_BOT_ID after rollback');
    assert.match(envContent, /OTHER=stay/, 'Other env entries preserved');

    WeComBotAdapter.validateCredentials = original;
    await app.close();
  });

  it('returns 422 when credentials are invalid', async () => {
    const original = WeComBotAdapter.validateCredentials;
    WeComBotAdapter.validateCredentials = async () => ({ valid: false, error: 'Bad credentials' });

    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/wecom-bot/validate',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ botId: 'bad', secret: 'bad' }),
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 422);
    assert.equal(body.valid, false);
    assert.equal(body.error, 'Bad credentials');

    WeComBotAdapter.validateCredentials = original;
    await app.close();
  });

  it('P1: does not stop existing adapter when validation fails (no live-connection kill)', async () => {
    const original = WeComBotAdapter.validateCredentials;
    WeComBotAdapter.validateCredentials = async () => ({ valid: false, error: 'Bad credentials' });

    let stopCalled = false;
    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      stopWeComBot: async () => {
        stopCalled = true;
      },
    });
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/api/connector/wecom-bot/validate',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ botId: 'bad', secret: 'bad' }),
    });

    assert.equal(
      stopCalled,
      false,
      'stopWeComBot must NOT be called when validation fails — it kills the live connection',
    );

    WeComBotAdapter.validateCredentials = original;
    await app.close();
  });
});

describe('POST /api/connector/wecom-bot/disconnect', () => {
  it('returns 401 without auth header', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/connector/wecom-bot/disconnect' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('calls stopWeComBot, clears credentials, returns ok', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'wecom-disconnect-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'WECOM_BOT_ID=old-bot\nWECOM_BOT_SECRET=old-sec\nKEEP=yes\n');
    process.env.WECOM_BOT_ID = 'old-bot';
    process.env.WECOM_BOT_SECRET = 'old-sec';

    let stopped = false;
    const app = Fastify();
    await app.register(connectorHubRoutes, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
      stopWeComBot: async () => {
        stopped = true;
      },
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/wecom-bot/disconnect',
      headers: AUTH_HEADERS,
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(stopped, true, 'stopWeComBot must be called');
    assert.equal(process.env.WECOM_BOT_ID, undefined);
    assert.equal(process.env.WECOM_BOT_SECRET, undefined);

    const envContent = readFileSync(envFilePath, 'utf8');
    assert.ok(!envContent.includes('WECOM_BOT_ID'), 'WECOM_BOT_ID cleared from .env');
    assert.ok(!envContent.includes('WECOM_BOT_SECRET'), 'WECOM_BOT_SECRET cleared from .env');
    assert.match(envContent, /KEEP=yes/, 'Other entries preserved');

    await app.close();
  });
});
