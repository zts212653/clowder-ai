import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

const { connectorHubRoutes, invalidateManifestCache } = await import('../dist/routes/connector-hub.js');
const { configEventBus } = await import('../dist/config/config-event-bus.js');
const { clearConnectorConfigCache, writeConnectorConfig } = await import(
  '../dist/infrastructure/connectors/im-connector-config-store.js'
);

const OWNER_ID = 'owner-1';
const AUTH_HEADERS = { 'x-cat-cafe-user': OWNER_ID, 'x-test-session-user': OWNER_ID };
const HEADER_ONLY_AUTH = { 'x-cat-cafe-user': OWNER_ID };
const REMOTE_OWNER_HEADERS = {
  ...AUTH_HEADERS,
  host: 'hub.example.test',
  origin: 'https://hub.example.test',
  'x-forwarded-for': '203.0.113.10',
};
const ORIGINAL_OWNER_ID = process.env.DEFAULT_OWNER_USER_ID;

async function registerConnectorHub(app, opts) {
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  await app.register(connectorHubRoutes, opts);
}

beforeEach(() => {
  process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
});

afterEach(() => {
  if (ORIGINAL_OWNER_ID === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = ORIGINAL_OWNER_ID;
});

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
  await registerConnectorHub(app, { threadStore });
  await app.ready();
  return { app, listCalls };
}

describe('F134 follow-up — Feishu QR bind routes', () => {
  it('POST /api/connector/feishu/qrcode returns QR payload from bind client', async () => {
    const app = Fastify();
    await registerConnectorHub(app, {
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
    const previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    writeFileSync(envFilePath, 'FEISHU_CONNECTION_MODE=webhook\n');
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_VERIFICATION_TOKEN;
    process.env.FEISHU_CONNECTION_MODE = 'webhook';
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    clearConnectorConfigCache();

    const app = Fastify();
    try {
      await registerConnectorHub(app, {
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

      const storedConfig = JSON.parse(
        readFileSync(join(tmpDir, '.cat-cafe', 'im-connector-config', 'feishu.json'), 'utf8'),
      );
      assert.equal(storedConfig.FEISHU_APP_ID, 'cli_feishu');
      assert.equal(storedConfig.FEISHU_APP_SECRET, 'sec_feishu');
      assert.equal(storedConfig.FEISHU_CONNECTION_MODE, 'websocket');
    } finally {
      await app.close();
      if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
      clearConnectorConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
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
    await registerConnectorHub(app, {
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

  it('GET /api/connector/feishu/qrcode-status preserves config-store webhook settings', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'feishu-qr-bind-store-'));
    const envFilePath = join(tmpDir, '.env');
    const previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const previousMode = process.env.FEISHU_CONNECTION_MODE;
    const previousToken = process.env.FEISHU_VERIFICATION_TOKEN;
    writeFileSync(envFilePath, 'FEISHU_CONNECTION_MODE=webhook\n');
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_VERIFICATION_TOKEN;
    process.env.FEISHU_CONNECTION_MODE = 'webhook';
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    clearConnectorConfigCache();
    writeConnectorConfig(tmpDir, 'feishu', [
      { name: 'FEISHU_CONNECTION_MODE', value: 'webhook' },
      { name: 'FEISHU_VERIFICATION_TOKEN', value: 'vt_store' },
    ]);

    const app = Fastify();
    try {
      await registerConnectorHub(app, {
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
            return { status: 'confirmed', appId: 'cli_feishu_store', appSecret: 'sec_feishu_store' };
          },
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/connector/feishu/qrcode-status?qrPayload=device-store',
        headers: AUTH_HEADERS,
      });
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 200);
      assert.equal(body.status, 'confirmed');
      assert.equal(process.env.FEISHU_CONNECTION_MODE, 'webhook');
      assert.doesNotMatch(readFileSync(envFilePath, 'utf8'), /FEISHU_CONNECTION_MODE=websocket/);

      const storedConfig = JSON.parse(
        readFileSync(join(tmpDir, '.cat-cafe', 'im-connector-config', 'feishu.json'), 'utf8'),
      );
      assert.equal(storedConfig.FEISHU_CONNECTION_MODE, 'webhook');
      assert.equal(storedConfig.FEISHU_VERIFICATION_TOKEN, 'vt_store');
      assert.equal(storedConfig.FEISHU_APP_ID, 'cli_feishu_store');
      assert.equal(storedConfig.FEISHU_APP_SECRET, 'sec_feishu_store');
    } finally {
      await app.close();
      if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
      if (previousMode === undefined) delete process.env.FEISHU_CONNECTION_MODE;
      else process.env.FEISHU_CONNECTION_MODE = previousMode;
      if (previousToken === undefined) delete process.env.FEISHU_VERIFICATION_TOKEN;
      else process.env.FEISHU_VERIFICATION_TOKEN = previousToken;
      clearConnectorConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/connector/feishu/disconnect', () => {
  it('clears FEISHU_APP_ID and FEISHU_APP_SECRET via applyConnectorSecretUpdates and returns ok', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'feishu-disconnect-'));
    const envFilePath = join(tmpDir, '.env');
    const configDir = join(tmpDir, '.cat-cafe', 'im-connector-config');
    const previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    mkdirSync(configDir, { recursive: true });
    writeFileSync(envFilePath, 'FEISHU_APP_ID=cli_old\nFEISHU_APP_SECRET=sec_old\nFEISHU_CONNECTION_MODE=websocket\n');
    writeFileSync(
      join(configDir, 'feishu.json'),
      JSON.stringify({ FEISHU_APP_ID: 'stored_old', FEISHU_APP_SECRET: 'stored_secret' }),
    );
    process.env.FEISHU_APP_ID = 'cli_old';
    process.env.FEISHU_APP_SECRET = 'sec_old';
    process.env.FEISHU_CONNECTION_MODE = 'websocket';
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    clearConnectorConfigCache();

    const app = Fastify();
    try {
      await registerConnectorHub(app, {
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

      const storedConfig = JSON.parse(readFileSync(join(configDir, 'feishu.json'), 'utf8'));
      assert.equal(storedConfig.FEISHU_APP_ID, null);
      assert.equal(storedConfig.FEISHU_APP_SECRET, null);
    } finally {
      await app.close();
      if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
      clearConnectorConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns 401 without auth header', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/connector/feishu/disconnect' });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('allows disconnect in single-user mode when DEFAULT_OWNER_USER_ID is not configured (issue #794)', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'feishu-disconnect-owner-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'FEISHU_APP_ID=cli_old\nFEISHU_APP_SECRET=sec_old\n');
    process.env.FEISHU_APP_ID = 'cli_old';
    process.env.FEISHU_APP_SECRET = 'sec_old';
    delete process.env.DEFAULT_OWNER_USER_ID;

    const app = Fastify();
    await registerConnectorHub(app, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
    });
    await app.ready();

    const res = await app.inject({ method: 'POST', url: '/api/connector/feishu/disconnect', headers: AUTH_HEADERS });
    assert.notEqual(res.statusCode, 403, 'should not 403 in single-user mode');

    await app.close();
  });
});

describe('GET /api/connector/weixin/qrcode-status — adapter not ready', () => {
  it('P1: returns 503 when QR confirms but weixinAdapter is not available (cloud review a312a53f)', async () => {
    // Arrange: inject a mock fetch that makes pollQrCodeStatus return 'confirmed'
    const { WeixinAdapter: WA } = await import(
      '../dist/infrastructure/connectors/im-connectors/weixin/WeixinAdapter.js'
    );
    const originalFetch = globalThis.fetch;
    WA._injectStaticFetch(async () => ({
      ok: true,
      json: async () => ({ errcode: 0, status: 2, bot_token: 'tok_secret_123' }),
    }));

    const app = Fastify();
    // Register with weixinAdapter deliberately missing (simulates gateway not started)
    await registerConnectorHub(app, {
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
    const { WeixinAdapter: WA } = await import(
      '../dist/infrastructure/connectors/im-connectors/weixin/WeixinAdapter.js'
    );
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
    await registerConnectorHub(app, {
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
    const { WeixinAdapter: WA } = await import(
      '../dist/infrastructure/connectors/im-connectors/weixin/WeixinAdapter.js'
    );
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
    await registerConnectorHub(app, {
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
    await registerConnectorHub(app, {
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
    await registerConnectorHub(app, {
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
    await registerConnectorHub(app, {
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

  it('rejects localhost origin fallback without a real session', async () => {
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

    assert.equal(res.statusCode, 401);
    assert.deepEqual(listCalls, []);
    await app.close();
  });

  it('uses the session identity and returns hub threads sorted by createdAt desc', async () => {
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

const { WeComBotAdapter } = await import(
  '../dist/infrastructure/connectors/im-connectors/wecom-bot/WeComBotAdapter.js'
);

describe('GET /api/connector/status — WeCom Bot live health', () => {
  it('rejects trusted header identity without a real session', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/connector/status',
      headers: HEADER_ONLY_AUTH,
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('P1: shows configured=false when adapter getter returns null (not false green from env)', async () => {
    const savedBotId = process.env.WECOM_BOT_ID;
    const savedSecret = process.env.WECOM_BOT_SECRET;
    process.env.WECOM_BOT_ID = 'some-bot';
    process.env.WECOM_BOT_SECRET = 'some-secret';

    const app = Fastify();
    await registerConnectorHub(app, {
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

  it('rejects trusted header identity without a real session', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/wecom-bot/validate',
      headers: HEADER_ONLY_AUTH,
      payload: { botId: 'bot1', secret: 'sec1' },
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('rejects redacted placeholders before validating credentials', async () => {
    const original = WeComBotAdapter.validateCredentials;
    let validateCalled = false;
    WeComBotAdapter.validateCredentials = async () => {
      validateCalled = true;
      return { valid: true };
    };

    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/wecom-bot/validate',
      headers: { ...AUTH_HEADERS, 'content-type': 'application/json' },
      payload: JSON.stringify({ botId: 'bot1', secret: '••••••' }),
    });

    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).error, /redacted/i);
    assert.equal(validateCalled, false, 'redacted placeholder must be rejected before external validation');

    WeComBotAdapter.validateCredentials = original;
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
    await registerConnectorHub(app, {
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
    await registerConnectorHub(app, {
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
    await registerConnectorHub(app, {
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

describe('P1 — connector writes from non-loopback without configured owner', () => {
  it('blocks connector secret writes from non-loopback IP when DEFAULT_OWNER_USER_ID is unset', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;

    const tmpDir = mkdtempSync(join(os.tmpdir(), 'connector-network-guard-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'FEISHU_APP_ID=old\nFEISHU_APP_SECRET=old\n');

    const app = Fastify();
    await registerConnectorHub(app, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
    });
    await app.ready();

    // Simulate a non-loopback (LAN) request
    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/feishu/disconnect',
      headers: AUTH_HEADERS,
      remoteAddress: '192.168.1.100',
    });

    assert.equal(res.statusCode, 403, 'non-loopback connector write without owner must be 403');
    const body = JSON.parse(res.body);
    assert.ok(body.error, 'response should contain error message');

    await app.close();
  });

  it('allows connector secret writes from non-loopback when DEFAULT_OWNER_USER_ID IS configured', async () => {
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;

    const tmpDir = mkdtempSync(join(os.tmpdir(), 'connector-network-owner-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'FEISHU_APP_ID=old\nFEISHU_APP_SECRET=old\n');

    const app = Fastify();
    await registerConnectorHub(app, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/feishu/disconnect',
      headers: AUTH_HEADERS,
      remoteAddress: '192.168.1.100',
    });

    assert.equal(res.statusCode, 200, 'non-loopback connector write with configured owner should pass');

    await app.close();
  });

  it('blocks proxy-forwarded loopback connector writes when owner is not configured (#794 proxy guard)', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;

    const tmpDir = mkdtempSync(join(os.tmpdir(), 'connector-proxy-guard-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'FEISHU_APP_ID=old\nFEISHU_APP_SECRET=old\n');

    const app = Fastify();
    await registerConnectorHub(app, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
    });
    await app.ready();

    // Loopback IP but with proxy forwarding header → reverse proxy scenario
    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/feishu/disconnect',
      headers: { ...AUTH_HEADERS, 'x-forwarded-for': '203.0.113.50' },
    });

    assert.equal(res.statusCode, 403, 'proxy-forwarded loopback connector write without owner must be 403');

    await app.close();
  });

  it('allows connector secret writes from loopback even without configured owner', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;

    const tmpDir = mkdtempSync(join(os.tmpdir(), 'connector-loopback-'));
    const envFilePath = join(tmpDir, '.env');
    writeFileSync(envFilePath, 'FEISHU_APP_ID=old\nFEISHU_APP_SECRET=old\n');

    const app = Fastify();
    await registerConnectorHub(app, {
      threadStore: {
        async list() {
          return [];
        },
      },
      envFilePath,
    });
    await app.ready();

    // Default remoteAddress in Fastify inject is 127.0.0.1 (loopback)
    const res = await app.inject({
      method: 'POST',
      url: '/api/connector/feishu/disconnect',
      headers: AUTH_HEADERS,
    });

    assert.notEqual(res.statusCode, 403, 'loopback connector write without owner should NOT be 403');

    await app.close();
  });
});

describe('PUT /api/connectors/:connectorId/config — external plugin reload', () => {
  it('allows owner-authenticated remote connector config writes', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'connector-config-remote-owner-'));
    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    clearConnectorConfigCache();
    invalidateManifestCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PUT',
        url: '/api/connectors/feishu/config',
        headers: REMOTE_OWNER_HEADERS,
        payload: { fields: [{ name: 'FEISHU_APP_ID', value: 'cli_remote_owner' }] },
      });

      assert.equal(res.statusCode, 200, res.body);
      const raw = JSON.parse(readFileSync(join(tmpDir, '.cat-cafe', 'im-connector-config', 'feishu.json'), 'utf8'));
      assert.equal(raw.FEISHU_APP_ID, 'cli_remote_owner');

      await app.close();
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      clearConnectorConfigCache();
      invalidateManifestCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects remote connector config writes when no owner is configured', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'connector-config-remote-no-owner-'));
    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    delete process.env.DEFAULT_OWNER_USER_ID;
    clearConnectorConfigCache();
    invalidateManifestCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PUT',
        url: '/api/connectors/feishu/config',
        headers: REMOTE_OWNER_HEADERS,
        payload: { fields: [{ name: 'FEISHU_APP_ID', value: 'cli_remote_no_owner' }] },
      });

      assert.equal(res.statusCode, 403);
      assert.match(JSON.parse(res.body).error, /DEFAULT_OWNER_USER_ID|non-localhost/i);

      await app.close();
    } finally {
      process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      clearConnectorConfigCache();
      invalidateManifestCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('emits file-scope reload events for external connector env keys', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'external-config-reload-'));
    const pluginId = 'reload-probe';
    const pluginDir = join(tmpDir, '.cat-cafe', 'plugins', pluginId);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Reload Probe',
        'nameEn: Reload Probe',
        'version: 1.0.0',
        'source: external',
        "themeColor: '#336699'",
        'icon:',
        '  type: png',
        '  src: /test.png',
        'docsUrl: https://example.com/reload-probe',
        'config:',
        '  - envName: RELOAD_PROBE_TOKEN',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        'steps:',
        '  - text: Save token',
      ].join('\n'),
    );

    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const captured = [];
    const unsub = configEventBus.onConfigChange((event) => captured.push(event));
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    invalidateManifestCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PUT',
        url: `/api/connectors/${pluginId}/config`,
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
          host: '127.0.0.1:3002',
          origin: 'http://127.0.0.1:3001',
        },
        payload: JSON.stringify({ fields: [{ name: 'RELOAD_PROBE_TOKEN', value: 'secret' }] }),
      });

      assert.equal(res.statusCode, 200);
      const event = captured.find((entry) => entry.changedKeys?.includes('RELOAD_PROBE_TOKEN'));
      assert.ok(event, 'connector config write must emit a reload event');
      assert.equal(event.scope, 'file', 'external connector keys must not be dropped by static key filtering');
      assert.deepEqual(event.changedKeys, ['RELOAD_PROBE_TOKEN']);

      await app.close();
    } finally {
      unsub();
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      invalidateManifestCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects redacted placeholders before writing external connector config', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'external-config-redacted-'));
    const pluginId = 'redacted-probe';
    const pluginDir = join(tmpDir, '.cat-cafe', 'plugins', pluginId);
    const configPath = join(tmpDir, '.cat-cafe', 'im-connector-config', `${pluginId}.json`);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Redacted Probe',
        'nameEn: Redacted Probe',
        'version: 1.0.0',
        'source: external',
        "themeColor: '#336699'",
        'icon:',
        '  type: png',
        '  src: /test.png',
        'docsUrl: https://example.com/redacted-probe',
        'config:',
        '  - envName: REDACTED_PROBE_TOKEN',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        'steps:',
        '  - text: Save token',
      ].join('\n'),
    );

    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const captured = [];
    const unsub = configEventBus.onConfigChange((event) => captured.push(event));
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    invalidateManifestCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'PUT',
        url: `/api/connectors/${pluginId}/config`,
        headers: {
          ...AUTH_HEADERS,
          'content-type': 'application/json',
          host: '127.0.0.1:3002',
          origin: 'http://127.0.0.1:3001',
        },
        payload: JSON.stringify({
          fields: [{ name: 'REDACTED_PROBE_TOKEN', value: '\u2022\u2022\u2022\u2022\u2022\u2022' }],
        }),
      });

      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /redacted/i);
      assert.equal(existsSync(configPath), false, 'redacted placeholder must not be persisted');
      assert.equal(
        captured.some((entry) => entry.changedKeys?.includes('REDACTED_PROBE_TOKEN')),
        false,
        'redacted placeholder must not emit reload events',
      );

      await app.close();
    } finally {
      unsub();
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      invalidateManifestCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('generic connector operation routes — remote owner auth', () => {
  it('allows owner-authenticated remote reset and action writes', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'connector-action-remote-owner-'));
    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    clearConnectorConfigCache();
    invalidateManifestCache();
    let handleCalls = 0;

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
        pluginRegistry: new Map([
          [
            'feishu',
            {
              id: 'feishu',
              async handleAction() {
                handleCalls += 1;
                return {
                  render: 'status',
                  data: { status: 'waiting' },
                  label: 'Still waiting',
                  advance: false,
                };
              },
            },
          ],
        ]),
      });
      await app.ready();

      const reset = await app.inject({
        method: 'POST',
        url: '/api/connectors/feishu/operations/feishu_qr_login/reset',
        headers: REMOTE_OWNER_HEADERS,
        payload: { currentAction: 'qr-generate' },
      });
      assert.equal(reset.statusCode, 200, reset.body);

      const action = await app.inject({
        method: 'POST',
        url: '/api/connectors/feishu/actions/feishu_qr_login/qr-status',
        headers: REMOTE_OWNER_HEADERS,
      });
      const body = JSON.parse(action.body);

      assert.equal(action.statusCode, 200, action.body);
      assert.equal(body.label, 'Still waiting');
      assert.equal(handleCalls, 1);

      await app.close();
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      clearConnectorConfigCache();
      invalidateManifestCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('GET /api/connector/status — external hidden fields', () => {
  it('scopes duplicate external env names to each connector when rendering status', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'external-status-env-scope-'));
    const pluginsDir = join(tmpDir, '.cat-cafe', 'plugins');
    const configDir = join(tmpDir, '.cat-cafe', 'im-connector-config');
    const firstId = 'status-env-scope-a';
    const secondId = 'status-env-scope-b';
    mkdirSync(join(pluginsDir, firstId), { recursive: true });
    mkdirSync(join(pluginsDir, secondId), { recursive: true });
    mkdirSync(configDir, { recursive: true });

    for (const [id, name] of [
      [firstId, 'Status Env Scope A'],
      [secondId, 'Status Env Scope B'],
    ]) {
      writeFileSync(
        join(pluginsDir, id, 'connector.yaml'),
        [
          `id: ${id}`,
          `name: ${name}`,
          `nameEn: ${name}`,
          'version: 1.0.0',
          'source: external',
          "themeColor: '#336699'",
          'icon:',
          '  type: png',
          '  src: /test.png',
          `docsUrl: https://example.com/${id}`,
          'config:',
          '  - envName: API_TOKEN',
          '    type: input',
          '    label: API Token',
          '    sensitive: false',
          '    required: true',
          'steps:',
          '  - text: Save token',
        ].join('\n'),
      );
    }
    writeFileSync(join(configDir, `${firstId}.json`), JSON.stringify({ API_TOKEN: 'first-connector-token' }));
    writeFileSync(join(configDir, `${secondId}.json`), JSON.stringify({ API_TOKEN: 'second-connector-token' }));

    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const previousToken = process.env.API_TOKEN;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    delete process.env.API_TOKEN;
    invalidateManifestCache();
    clearConnectorConfigCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/connector/status',
        headers: AUTH_HEADERS,
      });
      const body = JSON.parse(res.body);
      const first = body.platforms.find((p) => p.id === firstId);
      const second = body.platforms.find((p) => p.id === secondId);

      assert.equal(res.statusCode, 200);
      assert.equal(first?.configured, true);
      assert.equal(second?.configured, true);
      assert.equal(first?.fields.find((f) => f.envName === 'API_TOKEN')?.currentValue, 'first-connector-token');
      assert.equal(second?.fields.find((f) => f.envName === 'API_TOKEN')?.currentValue, 'second-connector-token');

      await app.close();
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      if (previousToken === undefined) delete process.env.API_TOKEN;
      else process.env.API_TOKEN = previousToken;
      invalidateManifestCache();
      clearConnectorConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses hidden value fields for configured calculation without rendering them', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'external-hidden-configured-'));
    const pluginId = 'hidden-config-probe';
    const pluginDir = join(tmpDir, '.cat-cafe', 'plugins', pluginId);
    const configDir = join(tmpDir, '.cat-cafe', 'im-connector-config');
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Hidden Config Probe',
        'nameEn: Hidden Config Probe',
        'version: 1.0.0',
        'source: external',
        "themeColor: '#336699'",
        'icon:',
        '  type: png',
        '  src: /test.png',
        'docsUrl: https://example.com/hidden-config-probe',
        'config:',
        '  - envName: HIDDEN_PROBE_TOKEN',
        '    type: input',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        '    hidden: true',
        'steps:',
        '  - text: Save token',
      ].join('\n'),
    );
    writeFileSync(join(configDir, `${pluginId}.json`), JSON.stringify({ HIDDEN_PROBE_TOKEN: 'stored-token' }));

    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const previousToken = process.env.HIDDEN_PROBE_TOKEN;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    delete process.env.HIDDEN_PROBE_TOKEN;
    invalidateManifestCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'GET',
        url: '/api/connector/status',
        headers: AUTH_HEADERS,
      });
      const body = JSON.parse(res.body);
      const probe = body.platforms.find((p) => p.id === pluginId);

      assert.equal(res.statusCode, 200);
      assert.ok(probe, 'external hidden-field connector must appear in status');
      assert.equal(probe.configured, true, 'hidden stored token must satisfy required configured status');
      assert.deepEqual(
        probe.fields.map((f) => f.envName),
        [],
        'hidden value fields must not be rendered in the Hub form',
      );

      await app.close();
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      if (previousToken === undefined) delete process.env.HIDDEN_PROBE_TOKEN;
      else process.env.HIDDEN_PROBE_TOKEN = previousToken;
      invalidateManifestCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/connector/:id/test — saved config store', () => {
  it('tests Telegram against Hub-saved config when process.env is unset', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'connector-test-saved-config-'));
    const configDir = join(tmpDir, '.cat-cafe', 'im-connector-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'telegram.json'),
      JSON.stringify({ TELEGRAM_BOT_TOKEN: '123456:stored_token_abc123' }),
    );

    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    delete process.env.TELEGRAM_BOT_TOKEN;
    invalidateManifestCache();
    clearConnectorConfigCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/connector/telegram/test',
        headers: AUTH_HEADERS,
      });
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 200);
      assert.equal(body.valid, true, 'test route must use stored connector config, not only process.env');

      await app.close();
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
      invalidateManifestCache();
      clearConnectorConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/connectors/:connectorId/actions — activation failure', () => {
  it('returns failure and does not persist connected state when activation throws', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'external-activation-failure-'));
    const pluginId = 'activation-failure-probe';
    const pluginDir = join(tmpDir, '.cat-cafe', 'plugins', pluginId);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Activation Failure Probe',
        'nameEn: Activation Failure Probe',
        'version: 1.0.0',
        'source: external',
        "themeColor: '#336699'",
        'icon:',
        '  type: png',
        '  src: /test.png',
        'docsUrl: https://example.com/activation-failure-probe',
        'config:',
        '  - envName: ACTIVATION_FAILURE_TOKEN',
        '    type: input',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        '  - name: connect',
        '    type: operation',
        '    label: Connect',
        '    target: [ACTIVATION_FAILURE_TOKEN]',
        '    actions:',
        '      - id: finish',
        '        label: Finish',
        '        render: button',
        '        next: disconnect',
        '      - id: disconnect',
        '        label: Disconnect',
        '        render: button',
        '        next: finish',
        'steps:',
        '  - text: Save token',
      ].join('\n'),
    );

    const plugin = {
      id: pluginId,
      definition: {
        id: pluginId,
        displayName: 'Activation Failure Probe',
        icon: { type: 'png', src: '/test.png' },
        themeColor: '#336699',
        description: 'activation failure regression',
      },
      requiredEnvKeys: ['ACTIVATION_FAILURE_TOKEN'],
      isConfigured: () => true,
      createAdapter: () => ({ id: pluginId, sendMessage() {} }),
      async handleAction() {
        return {
          render: 'status',
          data: { status: 'confirmed' },
          label: 'Connected',
          targetValues: { ACTIVATION_FAILURE_TOKEN: 'secret-token' },
        };
      },
    };

    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    invalidateManifestCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
        pluginRegistry: new Map([[pluginId, plugin]]),
        activateConnector: async () => {
          throw new Error('adapter failed to start');
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/api/connectors/${pluginId}/actions/connect/finish`,
        headers: {
          ...AUTH_HEADERS,
          host: '127.0.0.1:3002',
          origin: 'http://127.0.0.1:3001',
        },
      });
      const body = JSON.parse(res.body);
      const statesRes = await app.inject({
        method: 'GET',
        url: `/api/connectors/${pluginId}/operations`,
        headers: AUTH_HEADERS,
      });
      const states = JSON.parse(statesRes.body).operations;

      assert.equal(res.statusCode, 502);
      assert.equal(body.ok, false);
      assert.match(body.error, /activation failed/i);
      assert.equal(states.connect.currentAction, 'finish', 'activation failure must not persist connected step');

      await app.close();
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      invalidateManifestCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns failure and keeps disconnect state when deactivation throws', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'external-deactivation-failure-'));
    const pluginId = 'deactivation-failure-probe';
    const pluginDir = join(tmpDir, '.cat-cafe', 'plugins', pluginId);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Deactivation Failure Probe',
        'nameEn: Deactivation Failure Probe',
        'version: 1.0.0',
        'source: external',
        "themeColor: '#336699'",
        'icon:',
        '  type: png',
        '  src: /test.png',
        'docsUrl: https://example.com/deactivation-failure-probe',
        'config:',
        '  - envName: DEACTIVATION_FAILURE_TOKEN',
        '    type: input',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        '  - name: connect',
        '    type: operation',
        '    label: Connect',
        '    target: [DEACTIVATION_FAILURE_TOKEN]',
        '    actions:',
        '      - id: finish',
        '        label: Finish',
        '        render: button',
        '        next: disconnect',
        '      - id: disconnect',
        '        label: Disconnect',
        '        render: button',
        '        next: finish',
        'steps:',
        '  - text: Save token',
      ].join('\n'),
    );

    const plugin = {
      id: pluginId,
      definition: {
        id: pluginId,
        displayName: 'Deactivation Failure Probe',
        icon: { type: 'png', src: '/test.png' },
        themeColor: '#336699',
        description: 'deactivation failure regression',
      },
      requiredEnvKeys: ['DEACTIVATION_FAILURE_TOKEN'],
      isConfigured: () => true,
      createAdapter: () => ({ id: pluginId, sendMessage() {} }),
      async handleAction() {
        return {
          render: 'status',
          data: { status: 'disconnecting' },
          label: 'Disconnecting',
          targetValues: { DEACTIVATION_FAILURE_TOKEN: '' },
          activate: false,
        };
      },
    };

    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    invalidateManifestCache();
    writeConnectorConfig(tmpDir, pluginId, [{ name: 'DEACTIVATION_FAILURE_TOKEN', value: 'secret-token' }]);

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
        pluginRegistry: new Map([[pluginId, plugin]]),
        deactivateConnector: async () => {
          throw new Error('adapter failed to stop');
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/api/connectors/${pluginId}/actions/connect/disconnect`,
        headers: {
          ...AUTH_HEADERS,
          host: '127.0.0.1:3002',
          origin: 'http://127.0.0.1:3001',
        },
      });
      const body = JSON.parse(res.body);
      const statesRes = await app.inject({
        method: 'GET',
        url: `/api/connectors/${pluginId}/operations`,
        headers: AUTH_HEADERS,
      });
      const states = JSON.parse(statesRes.body).operations;
      const raw = JSON.parse(
        readFileSync(join(tmpDir, '.cat-cafe', 'im-connector-config', `${pluginId}.json`), 'utf8'),
      );

      assert.equal(res.statusCode, 502);
      assert.equal(body.ok, false);
      assert.match(body.error, /deactivation failed/i);
      assert.equal(states.connect.currentAction, 'disconnect', 'deactivation failure must keep the connected step');
      assert.equal(
        raw.DEACTIVATION_FAILURE_TOKEN,
        'secret-token',
        'deactivation failure must restore the previous connector credentials',
      );

      await app.close();
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      invalidateManifestCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('POST /api/connectors/:connectorId/actions — pending config values', () => {
  it('persists WeCom Bot pending credentials before activating', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'wecom-action-persist-'));
    const { default: wecomBotPlugin } = await import(
      '../dist/infrastructure/connectors/im-connectors/wecom-bot/index.js'
    );
    const { WeComBotAdapter } = await import(
      '../dist/infrastructure/connectors/im-connectors/wecom-bot/WeComBotAdapter.js'
    );
    const originalValidate = WeComBotAdapter.validateCredentials;
    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const previousBotId = process.env.WECOM_BOT_ID;
    const previousSecret = process.env.WECOM_BOT_SECRET;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    delete process.env.WECOM_BOT_ID;
    delete process.env.WECOM_BOT_SECRET;
    invalidateManifestCache();
    clearConnectorConfigCache();
    WeComBotAdapter.validateCredentials = async (botId, secret) => {
      assert.equal(botId, 'typed-bot-id');
      assert.equal(secret, 'typed-secret');
      return { valid: true };
    };
    let activationSawPersistedCredentials = false;

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
        pluginRegistry: new Map([['wecom-bot', wecomBotPlugin]]),
        activateConnector: async (connectorId) => {
          assert.equal(connectorId, 'wecom-bot');
          const raw = JSON.parse(
            readFileSync(join(tmpDir, '.cat-cafe', 'im-connector-config', 'wecom-bot.json'), 'utf8'),
          );
          activationSawPersistedCredentials =
            raw.WECOM_BOT_ID === 'typed-bot-id' && raw.WECOM_BOT_SECRET === 'typed-secret';
        },
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: '/api/connectors/wecom-bot/actions/wecom_validate/validate',
        headers: {
          ...AUTH_HEADERS,
          host: '127.0.0.1:3002',
          origin: 'http://127.0.0.1:3001',
        },
        payload: { values: { WECOM_BOT_ID: 'typed-bot-id', WECOM_BOT_SECRET: 'typed-secret' } },
      });
      const body = JSON.parse(res.body);
      const raw = JSON.parse(readFileSync(join(tmpDir, '.cat-cafe', 'im-connector-config', 'wecom-bot.json'), 'utf8'));

      assert.equal(res.statusCode, 200);
      assert.deepEqual(new Set(body.backfilledKeys), new Set(['WECOM_BOT_ID', 'WECOM_BOT_SECRET']));
      assert.equal(raw.WECOM_BOT_ID, 'typed-bot-id');
      assert.equal(raw.WECOM_BOT_SECRET, 'typed-secret');
      assert.equal(activationSawPersistedCredentials, true, 'activation must reload the saved credentials');

      await app.close();
    } finally {
      WeComBotAdapter.validateCredentials = originalValidate;
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      if (previousBotId === undefined) delete process.env.WECOM_BOT_ID;
      else process.env.WECOM_BOT_ID = previousBotId;
      if (previousSecret === undefined) delete process.env.WECOM_BOT_SECRET;
      else process.env.WECOM_BOT_SECRET = previousSecret;
      invalidateManifestCache();
      clearConnectorConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes request values to action handlers without persisting them directly', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'external-action-pending-values-'));
    const pluginId = 'pending-values-probe';
    const pluginDir = join(tmpDir, '.cat-cafe', 'plugins', pluginId);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Pending Values Probe',
        'nameEn: Pending Values Probe',
        'version: 1.0.0',
        'source: external',
        "themeColor: '#336699'",
        'icon:',
        '  type: png',
        '  src: /test.png',
        'docsUrl: https://example.com/pending-values-probe',
        'config:',
        '  - envName: PENDING_VALUES_TOKEN',
        '    type: input',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        '  - name: connect',
        '    type: operation',
        '    label: Connect',
        '    actions:',
        '      - id: validate',
        '        label: Validate',
        '        render: button',
        'steps:',
        '  - text: Enter token',
      ].join('\n'),
    );

    const plugin = {
      id: pluginId,
      definition: {
        id: pluginId,
        displayName: 'Pending Values Probe',
        icon: { type: 'png', src: '/test.png' },
        themeColor: '#336699',
        description: 'pending values regression',
      },
      requiredEnvKeys: ['PENDING_VALUES_TOKEN'],
      isConfigured: () => false,
      createAdapter: () => ({ id: pluginId, sendMessage() {} }),
      async handleAction(_operationName, _actionId, ctx) {
        if (ctx.env.PENDING_VALUES_TOKEN !== 'typed-token') {
          throw new Error(`missing pending token: ${ctx.env.PENDING_VALUES_TOKEN ?? '<unset>'}`);
        }
        return {
          render: 'status',
          data: { status: 'validated' },
          label: 'Validated pending token',
          advance: false,
        };
      },
    };

    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    invalidateManifestCache();
    clearConnectorConfigCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
        pluginRegistry: new Map([[pluginId, plugin]]),
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/api/connectors/${pluginId}/actions/connect/validate`,
        headers: {
          ...AUTH_HEADERS,
          host: '127.0.0.1:3002',
          origin: 'http://127.0.0.1:3001',
        },
        payload: { values: { PENDING_VALUES_TOKEN: 'typed-token', OTHER_TOKEN: 'ignored' } },
      });
      const body = JSON.parse(res.body);
      const configPath = join(tmpDir, '.cat-cafe', 'im-connector-config', `${pluginId}.json`);
      const raw = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};

      assert.equal(res.statusCode, 200);
      assert.equal(body.label, 'Validated pending token');
      assert.equal(raw.PENDING_VALUES_TOKEN, undefined, 'pending action values must not be persisted directly');

      await app.close();
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      invalidateManifestCache();
      clearConnectorConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('passes Redis to connector action handlers', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'external-action-redis-ctx-'));
    const pluginId = 'redis-action-context-probe';
    const pluginDir = join(tmpDir, '.cat-cafe', 'plugins', pluginId);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Redis Action Context Probe',
        'nameEn: Redis Action Context Probe',
        'version: 1.0.0',
        'source: external',
        "themeColor: '#336699'",
        'icon:',
        '  type: png',
        '  src: /test.png',
        'docsUrl: https://example.com/redis-action-context-probe',
        'config:',
        '  - envName: REDIS_ACTION_TOKEN',
        '    type: input',
        '    label: Token',
        '    sensitive: true',
        '    required: false',
        '  - name: connect',
        '    type: operation',
        '    label: Connect',
        '    actions:',
        '      - id: validate',
        '        label: Validate',
        '        render: button',
        'steps:',
        '  - text: Validate',
      ].join('\n'),
    );

    const redis = {
      async get() {
        return 'cached-token';
      },
    };
    let seenRedis;
    const plugin = {
      id: pluginId,
      definition: {
        id: pluginId,
        displayName: 'Redis Action Context Probe',
        icon: { type: 'png', src: '/test.png' },
        themeColor: '#336699',
        description: 'redis action context regression',
      },
      requiredEnvKeys: [],
      isConfigured: () => true,
      createAdapter: () => ({ id: pluginId, sendMessage() {} }),
      async handleAction(_operationName, _actionId, ctx) {
        seenRedis = ctx.redis;
        return {
          render: 'status',
          data: { status: await ctx.redis?.get('probe-key') },
          label: 'Redis checked',
          advance: false,
        };
      },
    };

    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    invalidateManifestCache();
    clearConnectorConfigCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
        pluginRegistry: new Map([[pluginId, plugin]]),
        redis,
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/api/connectors/${pluginId}/actions/connect/validate`,
        headers: {
          ...AUTH_HEADERS,
          host: '127.0.0.1:3002',
          origin: 'http://127.0.0.1:3001',
        },
      });
      const body = JSON.parse(res.body);

      assert.equal(res.statusCode, 200, res.body);
      assert.strictEqual(seenRedis, redis, 'action ctx must receive the gateway Redis dependency');
      assert.equal(body.data.status, 'cached-token');

      await app.close();
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      invalidateManifestCache();
      clearConnectorConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects redacted pending values before action handlers run', async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), 'external-action-redacted-values-'));
    const pluginId = 'redacted-action-values-probe';
    const pluginDir = join(tmpDir, '.cat-cafe', 'plugins', pluginId);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Redacted Action Values Probe',
        'nameEn: Redacted Action Values Probe',
        'version: 1.0.0',
        'source: external',
        "themeColor: '#884422'",
        'icon:',
        '  type: png',
        '  src: /test.png',
        'docsUrl: https://example.com/redacted-action-values-probe',
        'config:',
        '  - envName: REDACTED_ACTION_TOKEN',
        '    type: input',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        '  - name: connect',
        '    type: operation',
        '    label: Connect',
        '    actions:',
        '      - id: validate',
        '        label: Validate',
        '        render: button',
        'steps:',
        '  - text: Enter token',
      ].join('\n'),
    );

    let actionCalled = false;
    const plugin = {
      id: pluginId,
      definition: {
        id: pluginId,
        displayName: 'Redacted Action Values Probe',
        icon: { type: 'png', src: '/test.png' },
        themeColor: '#884422',
        description: 'redacted action values regression',
      },
      requiredEnvKeys: ['REDACTED_ACTION_TOKEN'],
      isConfigured: () => false,
      createAdapter: () => ({ id: pluginId, sendMessage() {} }),
      async handleAction() {
        actionCalled = true;
        return {
          render: 'status',
          data: { status: 'validated' },
          label: 'Should not run',
          advance: false,
        };
      },
    };

    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = tmpDir;
    invalidateManifestCache();
    clearConnectorConfigCache();

    try {
      const app = Fastify();
      await registerConnectorHub(app, {
        threadStore: {
          async list() {
            return [];
          },
        },
        pluginRegistry: new Map([[pluginId, plugin]]),
      });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/api/connectors/${pluginId}/actions/connect/validate`,
        headers: {
          ...AUTH_HEADERS,
          host: '127.0.0.1:3002',
          origin: 'http://127.0.0.1:3001',
        },
        payload: { values: { REDACTED_ACTION_TOKEN: '••••••' } },
      });
      const configPath = join(tmpDir, '.cat-cafe', 'im-connector-config', `${pluginId}.json`);

      assert.equal(res.statusCode, 400);
      assert.match(JSON.parse(res.body).error, /redacted/i);
      assert.equal(actionCalled, false, 'redacted pending values must be rejected before plugin action execution');
      assert.equal(existsSync(configPath), false, 'redacted pending values must not be persisted by action backfill');

      await app.close();
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      invalidateManifestCache();
      clearConnectorConfigCache();
      rmSync(tmpDir, { recursive: true, force: true });
    }
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
    await registerConnectorHub(app, {
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
