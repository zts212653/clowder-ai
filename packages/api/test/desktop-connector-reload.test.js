import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { EventAuditLog } from '../dist/domains/cats/services/orchestration/EventAuditLog.js';
import { startConnectorGateway } from '../dist/infrastructure/connectors/connector-gateway-bootstrap.js';
import { restartConnectorGateway } from '../dist/infrastructure/connectors/connector-gateway-lifecycle.js';
import { createConnectorReloadSubscriber } from '../dist/infrastructure/connectors/connector-reload-subscriber.js';
import {
  clearConnectorConfigCache,
  readConnectorStoredConfig,
  writeOperationState,
} from '../dist/infrastructure/connectors/im-connector-config-store.js';
import { TelegramAdapter } from '../dist/infrastructure/connectors/im-connectors/telegram/TelegramAdapter.js';
import { WeixinAdapter } from '../dist/infrastructure/connectors/im-connectors/weixin/WeixinAdapter.js';
import { scanConnectorManifests } from '../dist/infrastructure/connectors/plugins/im-connector-manifest.js';
import { connectorActionRoutes } from '../dist/routes/connector-plugin-routes.js';
import { _clearActiveRootCacheForTest } from '../dist/utils/active-project-root.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-connector-reload-'));
  const env = {
    CAT_CAFE_CONFIG_ROOT: root,
    CONNECTOR_MEDIA_DIR: join(root, 'media'),
    AUDIT_LOG_DIR: join(root, 'audit'),
    LOCALAPPDATA: root,
    HOME: root,
    DEFAULT_OWNER_USER_ID: 'owner-test',
    CONNECTOR_GATEWAY_AUTOSTART: undefined,
  };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  clearConnectorConfigCache();
  _clearActiveRootCacheForTest();
  const live = new Map();
  const threads = [];
  let handle;
  let subscriber;
  const app = Fastify();
  t.after(async () => {
    subscriber?.unsubscribe();
    await handle?.stop();
    await app.close();
    clearConnectorConfigCache();
    _clearActiveRootCacheForTest();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  // Transport and the process-global audit sink are mocked. Config persistence, Hub routes, lifecycle,
  // plugin setup and the inbound router are the real implementations.
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected network call in isolated test');
  });
  t.mock.method(EventAuditLog.prototype, 'append', async (input) => ({
    id: 'audit-test',
    timestamp: Date.now(),
    ...input,
  }));
  for (const Adapter of [TelegramAdapter, WeixinAdapter]) {
    t.mock.method(Adapter.prototype, 'startPolling', function (onMessage) {
      live.set(this, onMessage);
    });
    t.mock.method(Adapter.prototype, 'stopPolling', async function () {
      live.delete(this);
    });
  }
  const ServiceManager = require('../../../desktop/service-manager.js');
  const manager = new ServiceManager(repoRoot, { frontendPort: 3101, apiPort: 3102 });
  const autostartEnv = manager._buildApiEnv(root);
  const deps = {
    messageStore: {
      async append(input) {
        return { id: 'message-test', ...input };
      },
    },
    threadStore: {
      create(userId, title) {
        const thread = { id: `thread-${threads.length}`, createdBy: userId, title };
        threads.push(thread);
        return thread;
      },
    },
    invokeTrigger: { trigger() {} },
    socketManager: { broadcastToRoom() {} },
    defaultUserId: 'owner-test',
    defaultCatId: 'opus',
    log: app.log,
  };
  const start = () => startConnectorGateway({}, deps, { autostartEnv });
  handle = await start();
  const manifests = scanConnectorManifests(join(repoRoot, 'packages/api/src/infrastructure/connectors/im-connectors'));
  const opts = { getManifests: () => manifests };
  const wire = () =>
    Object.assign(opts, {
      pluginRegistry: handle.pluginRegistry,
      adapterRegistry: handle.adapterRegistry,
      activateConnector: handle.activateConnector,
      deactivateConnector: handle.deactivateConnector,
    });
  wire();
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = 'owner-test';
  });
  connectorActionRoutes(opts)(app);
  const reloaded = Promise.withResolvers();
  subscriber = createConnectorReloadSubscriber({
    debounceMs: 5,
    log: app.log,
    async onRestart() {
      try {
        handle = await restartConnectorGateway(handle, start);
        wire();
        reloaded.resolve();
      } catch (err) {
        reloaded.reject(err);
      }
    },
  });
  return { root, app, live, threads, reloaded: reloaded.promise, getHandle: () => handle };
}

test('desktop Weixin QR confirmation survives credential backfill and gateway reload', { timeout: 5000 }, async (t) => {
  const ctx = await setup(t);
  const oldAdapter = ctx.getHandle().weixinAdapter;
  writeOperationState(ctx.root, 'weixin', 'weixin_qr_login', {
    currentAction: 'qr-status',
    lastResult: { render: 'img', data: { qrPayload: 'fixture-qr' } },
    updatedAt: Date.now(),
  });
  t.mock.method(WeixinAdapter, 'pollQrCodeStatus', async () => ({
    status: 'confirmed',
    botToken: 'fixture-weixin-token',
  }));
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/api/connectors/weixin/actions/weixin_qr_login/qr-status',
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(ctx.live.has(oldAdapter), true, 'QR confirmation activates polling');
  await ctx.reloaded;
  const newAdapter = ctx.getHandle().weixinAdapter;
  assert.notEqual(newAdapter, oldAdapter);
  assert.equal(ctx.live.has(oldAdapter), false, 'old transport is stopped');
  assert.equal(readConnectorStoredConfig(ctx.root, 'weixin').WEIXIN_BOT_TOKEN, 'fixture-weixin-token');
  assert.equal(newAdapter.hasBotToken(), true, 'reload restores the saved token');
  assert.equal(ctx.live.has(newAdapter), true, 'replacement resumes inbound polling');
});

test(
  'desktop Telegram Hub save starts inbound after reload and a DM creates a thread',
  { timeout: 5000 },
  async (t) => {
    const ctx = await setup(t);
    assert.equal(ctx.getHandle().adapterRegistry.has('telegram'), false);
    const response = await ctx.app.inject({
      method: 'PUT',
      url: '/api/connectors/telegram/config',
      payload: { fields: [{ name: 'TELEGRAM_BOT_TOKEN', value: '123456:fixture_telegram_token' }] },
    });
    assert.equal(response.statusCode, 200, response.body);
    await ctx.reloaded;
    const adapter = ctx.getHandle().adapterRegistry.get('telegram');
    assert.ok(adapter, 'saved credentials must create a live adapter');
    const onMessage = ctx.live.get(adapter);
    assert.equal(typeof onMessage, 'function', 'inbound polling must be started');
    await onMessage({ chatId: '1234', text: 'hello', messageId: 'telegram-message-1' });
    assert.equal(ctx.threads.length, 1);
    assert.equal(ctx.threads[0].createdBy, 'owner-test');
  },
);
