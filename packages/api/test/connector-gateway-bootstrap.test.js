import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  classifyPreconfiguredConnectorAutostart,
  isPreconfiguredConnectorAutostartEnabled,
  startConnectorGateway,
} from '../dist/infrastructure/connectors/connector-gateway-bootstrap.js';
import {
  clearConnectorConfigCache,
  writeConnectorConfig,
} from '../dist/infrastructure/connectors/im-connector-config-store.js';
import { FeishuTokenManager } from '../dist/infrastructure/connectors/im-connectors/feishu/FeishuTokenManager.js';
import { TelegramAdapter } from '../dist/infrastructure/connectors/im-connectors/telegram/TelegramAdapter.js';
import { _clearActiveRootCacheForTest } from '../dist/utils/active-project-root.js';

function noopLog() {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  };
}

const baseDeps = {
  messageStore: {
    async append(input) {
      return { id: 'msg-1', ...input };
    },
  },
  threadStore: {
    create(userId, title) {
      return { id: 'thread-1', createdBy: userId, title };
    },
  },
  invokeTrigger: {
    trigger() {},
  },
  socketManager: {
    broadcastToRoom() {},
  },
  defaultUserId: 'owner-1',
  defaultCatId: 'opus',
  log: noopLog(),
};

function startPreconfiguredConnectorGateway(config, deps = baseDeps) {
  return startConnectorGateway(config, deps, {
    autostartEnv: { CONNECTOR_GATEWAY_AUTOSTART: '1' },
  });
}

describe('ConnectorGateway Bootstrap', () => {
  it('creates gateway in QR-only mode when no connectors configured', async () => {
    const result = await startConnectorGateway({}, baseDeps);
    assert.ok(result, 'Gateway should be created even without env tokens (for WeChat QR login)');
    assert.ok(result.weixinAdapter);
    assert.equal(result.weixinAdapter.hasBotToken(), false);
    assert.equal(result.webhookHandlers.size, 0);
    await result.stop();
  });

  it('creates gateway without feishu when verification token missing (fail-closed)', async () => {
    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
    };
    const result = await startPreconfiguredConnectorGateway(config);
    assert.ok(result, 'Gateway should be created');
    assert.equal(result.webhookHandlers.has('feishu'), false, 'Feishu should not be registered');
    assert.ok(result.weixinAdapter, 'WeChat adapter should always be present');
    await result.stop();
  });

  it('creates gateway handle with feishu webhook handler', async () => {
    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'test-token',
    };
    const handle = await startPreconfiguredConnectorGateway(config);
    assert.ok(handle);
    assert.ok(handle.outboundHook);
    assert.ok(handle.webhookHandlers.has('feishu'));
    assert.equal(typeof handle.stop, 'function');
    await handle.stop();
  });

  it('feishu webhook handler handles verification challenge', async () => {
    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'test-token',
    };
    const handle = await startPreconfiguredConnectorGateway(config);
    assert.ok(handle);

    const feishuHandler = handle.webhookHandlers.get('feishu');
    assert.ok(feishuHandler);

    const result = await feishuHandler.handleWebhook({ type: 'url_verification', challenge: 'my-challenge' }, {});
    assert.equal(result.kind, 'challenge');
    if (result.kind === 'challenge') {
      assert.equal(result.response.challenge, 'my-challenge');
    }
    await handle.stop();
  });

  it('feishu webhook handler routes DM text message', async () => {
    const triggerCalls = [];
    const deps = {
      ...baseDeps,
      invokeTrigger: {
        trigger(...args) {
          triggerCalls.push(args);
        },
      },
    };

    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'test-token',
    };
    const handle = await startPreconfiguredConnectorGateway(config, deps);
    assert.ok(handle);

    const feishuHandler = handle.webhookHandlers.get('feishu');
    const result = await feishuHandler.handleWebhook(
      {
        header: {
          event_type: 'im.message.receive_v1',
          event_id: 'evt-1',
          token: 'test-token',
        },
        event: {
          sender: {
            sender_id: { open_id: 'ou_user' },
            sender_type: 'user',
          },
          message: {
            message_id: 'om_msg_1',
            chat_id: 'oc_chat_1',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'Hello cat!' }),
            message_type: 'text',
          },
        },
      },
      {},
    );

    assert.equal(result.kind, 'processed');
    assert.equal(triggerCalls.length, 1);
    await handle.stop();
  });

  it('feishu webhook handler skips unsupported events', async () => {
    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'test-token',
    };
    const handle = await startPreconfiguredConnectorGateway(config);
    assert.ok(handle);

    const feishuHandler = handle.webhookHandlers.get('feishu');
    const result = await feishuHandler.handleWebhook(
      { header: { event_type: 'other.event', token: 'test-token' }, event: {} },
      {},
    );
    assert.equal(result.kind, 'skipped');
    await handle.stop();
  });

  it('uses coCreatorUserId from config for thread creation instead of deps.defaultUserId', async () => {
    const createdThreads = [];
    const deps = {
      ...baseDeps,
      defaultUserId: 'fallback-user',
      threadStore: {
        create(userId, title) {
          const t = { id: 'thread-owned', createdBy: userId, title };
          createdThreads.push(t);
          return t;
        },
      },
    };

    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'test-token',
      coCreatorUserId: 'you-real-id',
    };
    const handle = await startPreconfiguredConnectorGateway(config, deps);
    assert.ok(handle);

    const feishuHandler = handle.webhookHandlers.get('feishu');
    await feishuHandler.handleWebhook(
      {
        header: { event_type: 'im.message.receive_v1', event_id: 'evt-1', token: 'test-token' },
        event: {
          sender: { sender_id: { open_id: 'ou_user' } },
          message: {
            message_id: 'om_owner_test',
            chat_id: 'oc_owner_chat',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'test owner' }),
            message_type: 'text',
          },
        },
      },
      {},
    );

    assert.equal(createdThreads.length, 1);
    assert.equal(
      createdThreads[0].createdBy,
      'you-real-id',
      'thread should be created with coCreatorUserId, not fallback',
    );
    await handle.stop();
  });

  it('loadConnectorGatewayConfig reads DEFAULT_OWNER_USER_ID from env', async () => {
    const { loadConnectorGatewayConfig } = await import(
      '../dist/infrastructure/connectors/connector-gateway-bootstrap.js'
    );
    const originalEnv = process.env.DEFAULT_OWNER_USER_ID;
    try {
      process.env.DEFAULT_OWNER_USER_ID = 'env-owner-123';
      const config = loadConnectorGatewayConfig();
      assert.equal(config.coCreatorUserId, 'env-owner-123');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.DEFAULT_OWNER_USER_ID;
      } else {
        process.env.DEFAULT_OWNER_USER_ID = originalEnv;
      }
    }
  });

  it('ignores invalid TELEGRAM_BOT_TOKEN values without starting polling', async () => {
    const warnings = [];
    const originalStartPolling = TelegramAdapter.prototype.startPolling;
    TelegramAdapter.prototype.startPolling = function startPollingShouldNotRun() {
      throw new Error('Telegram polling should not start for invalid token');
    };

    const deps = {
      ...baseDeps,
      log: {
        ...noopLog(),
        warn(...args) {
          warnings.push(args);
        },
      },
    };

    try {
      const handle = await startPreconfiguredConnectorGateway(
        { telegramBotToken: 'sk-community-openai-api-key' },
        deps,
      );
      assert.ok(handle, 'Gateway should stay available for other connector surfaces');
      assert.ok(
        warnings.some((entry) => String(entry.at(-1)).includes('Invalid TELEGRAM_BOT_TOKEN')),
        'invalid token should be logged as a configuration warning',
      );
      await handle.stop();
    } finally {
      TelegramAdapter.prototype.startPolling = originalStartPolling;
    }
  });

  it('disables preconfigured connector autostart outside production by default', () => {
    assert.equal(
      isPreconfiguredConnectorAutostartEnabled({ NODE_ENV: 'development' }),
      false,
      'development API instances must not auto-connect external IM platforms',
    );
    assert.equal(isPreconfiguredConnectorAutostartEnabled({ NODE_ENV: 'test' }), false);
    assert.equal(
      isPreconfiguredConnectorAutostartEnabled({ NODE_ENV: 'production' }),
      false,
      'production mode alone is not a runtime identity; start:direct also runs NODE_ENV=production',
    );
    assert.equal(
      isPreconfiguredConnectorAutostartEnabled({
        NODE_ENV: 'production',
        CAT_CAFE_RUNTIME_ROOT: '/tmp/cat-cafe-runtime',
      }),
      false,
      'ambient production/runtime markers are not authorization to connect external IM platforms',
    );
    assert.equal(
      isPreconfiguredConnectorAutostartEnabled({
        NODE_ENV: 'development',
        CONNECTOR_GATEWAY_AUTOSTART: '1',
      }),
      true,
      'explicit override keeps connector integration test workflows possible',
    );
    assert.equal(
      isPreconfiguredConnectorAutostartEnabled({
        NODE_ENV: 'production',
        CONNECTOR_GATEWAY_AUTOSTART: '0',
      }),
      false,
      'explicit override can fail-closed even in production',
    );
  });

  it('distinguishes absent credentials from credentials suppressed by lifecycle policy', () => {
    assert.equal(classifyPreconfiguredConnectorAutostart({}, {}), 'disabled-no-credentials');
    assert.equal(
      classifyPreconfiguredConnectorAutostart(
        {
          feishuAppId: 'cli_test',
          feishuAppSecret: 'feishu-secret',
        },
        {},
      ),
      'disabled-credentials-suppressed',
    );
    assert.equal(
      classifyPreconfiguredConnectorAutostart(
        {
          feishuAppId: 'cli_test',
          feishuAppSecret: 'feishu-secret',
        },
        { CONNECTOR_GATEWAY_AUTOSTART: '1' },
      ),
      'enabled',
    );
    assert.equal(
      classifyPreconfiguredConnectorAutostart({}, { CONNECTOR_GATEWAY_AUTOSTART: '0' }, true),
      'disabled-credentials-suppressed',
      'final resolver may add credential presence from Hub store or installed plugins without exposing values',
    );
  });

  it('suppresses Hub-stored Feishu credentials at the final resolver when autostart is explicitly disabled', async () => {
    const configRoot = mkdtempSync(join(os.tmpdir(), 'connector-autostart-policy-'));
    const previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = configRoot;
    _clearActiveRootCacheForTest();
    clearConnectorConfigCache();

    try {
      writeConnectorConfig(configRoot, 'feishu', [
        { name: 'FEISHU_APP_ID', value: 'stored-app-id' },
        { name: 'FEISHU_APP_SECRET', value: 'stored-app-secret' },
        { name: 'FEISHU_VERIFICATION_TOKEN', value: 'stored-verification-token' },
      ]);

      const handle = await startConnectorGateway({}, baseDeps, {
        autostartEnv: { CONNECTOR_GATEWAY_AUTOSTART: '0' },
      });

      assert.ok(handle);
      assert.equal(handle.preconfiguredAutostartStatus, 'disabled-credentials-suppressed');
      assert.equal(
        handle.webhookHandlers.has('feishu'),
        false,
        'stored credentials must not bypass an explicit lifecycle opt-out',
      );
      assert.ok(handle.pluginRegistry.has('feishu'), 'manual setup surface must remain registered');
      assert.ok(handle.weixinAdapter, 'QR-only setup surface must remain available');
      await handle.stop();
    } finally {
      clearConnectorConfigCache();
      if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
      _clearActiveRootCacheForTest();
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it('suppresses installed-plugin process credentials while preserving explicit manual activation', async () => {
    const configRoot = mkdtempSync(join(os.tmpdir(), 'connector-plugin-autostart-policy-'));
    const pluginDir = join(configRoot, '.cat-cafe', 'plugins', 'autostart-fixture');
    const previousConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const previousFixtureToken = process.env.AUTOSTART_FIXTURE_TOKEN;
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        'id: autostart-fixture',
        'name: Autostart Fixture',
        'nameEn: Autostart Fixture',
        'version: 1.0.0',
        'icon:',
        '  type: svg',
        '  iconId: autostart-fixture',
        'themeColor: "#336699"',
        'docsUrl: https://example.com/autostart-fixture',
        'config:',
        '  - envName: AUTOSTART_FIXTURE_TOKEN',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        'steps:',
        '  - text: Configure token',
      ].join('\n'),
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      [
        'export default {',
        "  id: 'autostart-fixture',",
        "  definition: { id: 'autostart-fixture', displayName: 'Autostart Fixture', icon: { type: 'svg', iconId: 'autostart-fixture' }, themeColor: '#336699', description: 'fixture' },",
        "  requiredEnvKeys: ['AUTOSTART_FIXTURE_TOKEN'],",
        '  optionalEnvKeys: [],',
        '  isConfigured(env) { return Boolean(env.AUTOSTART_FIXTURE_TOKEN); },',
        "  createAdapter() { return { connectorId: 'autostart-fixture', async sendReply() {} }; },",
        '};',
      ].join('\n'),
    );
    process.env.CAT_CAFE_CONFIG_ROOT = configRoot;
    process.env.AUTOSTART_FIXTURE_TOKEN = 'installed-plugin-secret';
    _clearActiveRootCacheForTest();
    clearConnectorConfigCache();

    try {
      const handle = await startConnectorGateway({}, baseDeps, {
        autostartEnv: { CONNECTOR_GATEWAY_AUTOSTART: '0' },
      });

      assert.ok(handle);
      assert.equal(handle.preconfiguredAutostartStatus, 'disabled-credentials-suppressed');
      assert.ok(handle.pluginRegistry.has('autostart-fixture'), 'manual plugin surface must remain registered');
      assert.equal(handle.adapterRegistry.has('autostart-fixture'), false, 'process env must not auto-start plugin');

      await handle.activateConnector('autostart-fixture');
      assert.equal(handle.adapterRegistry.has('autostart-fixture'), true, 'explicit Hub action may activate plugin');
      await handle.stop();
    } finally {
      clearConnectorConfigCache();
      if (previousConfigRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousConfigRoot;
      if (previousFixtureToken === undefined) delete process.env.AUTOSTART_FIXTURE_TOKEN;
      else process.env.AUTOSTART_FIXTURE_TOKEN = previousFixtureToken;
      _clearActiveRootCacheForTest();
      rmSync(configRoot, { recursive: true, force: true });
    }
  });

  it('feishu webhook handler routes card action button click (AC-14)', async () => {
    const triggerCalls = [];
    const deps = {
      ...baseDeps,
      invokeTrigger: {
        trigger(...args) {
          triggerCalls.push(args);
        },
      },
    };

    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'test-token',
    };
    const handle = await startPreconfiguredConnectorGateway(config, deps);
    assert.ok(handle);

    const feishuHandler = handle.webhookHandlers.get('feishu');
    const result = await feishuHandler.handleWebhook(
      {
        header: {
          event_type: 'card.action.trigger',
          event_id: 'evt-card-1',
          token: 'test-token',
        },
        event: {
          operator: { open_id: 'ou_operator' },
          action: { value: { action: 'approve', threadId: 'th_123' }, tag: 'button' },
          context: { open_chat_id: 'oc_chat_card', open_chat_type: 'p2p' },
        },
      },
      {},
    );

    assert.equal(result.kind, 'processed');
    assert.equal(triggerCalls.length, 1, 'card action should trigger cat invocation');
    await handle.stop();
  });

  it('feishu webhook handler rejects card action when chatType unknown (fail-closed)', async () => {
    const triggerCalls = [];
    const deps = {
      ...baseDeps,
      invokeTrigger: {
        trigger(...args) {
          triggerCalls.push(args);
        },
      },
    };

    const stubTm = new FeishuTokenManager({
      appId: 'stub',
      appSecret: 'stub',
      fetchFn: async () => new Response(null, { status: 401 }),
    });

    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'test-token',
    };
    const handle = await startPreconfiguredConnectorGateway(config, {
      ...deps,
      _feishuTokenManagerOverride: stubTm,
    });

    const feishuHandler = handle.webhookHandlers.get('feishu');
    const result = await feishuHandler.handleWebhook(
      {
        header: {
          event_type: 'card.action.trigger',
          event_id: 'evt-card-no-ct',
          token: 'test-token',
        },
        event: {
          operator: { open_id: 'ou_operator' },
          action: { value: { cmd: '/threads' }, tag: 'button' },
          context: { open_chat_id: 'oc_chat_unknown' },
        },
      },
      {},
    );

    assert.equal(result.kind, 'skipped', 'card action without chatType must be rejected');
    assert.equal(triggerCalls.length, 0, 'must not invoke cat when chatType unknown');
    await handle.stop();
  });

  it('feishu webhook handler routes image message (Phase 5)', async () => {
    const triggerCalls = [];
    const deps = {
      ...baseDeps,
      invokeTrigger: {
        trigger(...args) {
          triggerCalls.push(args);
        },
      },
    };

    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'test-token',
    };
    const handle = await startPreconfiguredConnectorGateway(config, deps);
    assert.ok(handle);

    const feishuHandler = handle.webhookHandlers.get('feishu');
    const result = await feishuHandler.handleWebhook(
      {
        header: {
          event_type: 'im.message.receive_v1',
          event_id: 'evt-img-1',
          token: 'test-token',
        },
        event: {
          sender: { sender_id: { open_id: 'ou_user' } },
          message: {
            message_id: 'om_img_1',
            chat_id: 'oc_chat_img',
            chat_type: 'p2p',
            content: JSON.stringify({ image_key: 'img-key-abc' }),
            message_type: 'image',
          },
        },
      },
      {},
    );

    assert.equal(result.kind, 'processed');
    assert.equal(triggerCalls.length, 1, 'image message should trigger cat invocation');
    // The routed text should be [图片]
    assert.equal(triggerCalls[0][3], '[图片]');
    await handle.stop();
  });

  it('feishu webhook handler routes voice message (Phase 6)', async () => {
    const triggerCalls = [];
    const deps = {
      ...baseDeps,
      invokeTrigger: {
        trigger(...args) {
          triggerCalls.push(args);
        },
      },
    };

    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'test-token',
    };
    const handle = await startPreconfiguredConnectorGateway(config, deps);
    assert.ok(handle);

    const feishuHandler = handle.webhookHandlers.get('feishu');
    const result = await feishuHandler.handleWebhook(
      {
        header: {
          event_type: 'im.message.receive_v1',
          event_id: 'evt-voice-1',
          token: 'test-token',
        },
        event: {
          sender: { sender_id: { open_id: 'ou_user' } },
          message: {
            message_id: 'om_voice_1',
            chat_id: 'oc_chat_voice',
            chat_type: 'p2p',
            content: JSON.stringify({ file_key: 'audio-key-xyz', duration: 5 }),
            message_type: 'audio',
          },
        },
      },
      {},
    );

    assert.equal(result.kind, 'processed');
    assert.equal(triggerCalls.length, 1, 'voice message should trigger cat invocation');
    assert.equal(triggerCalls[0][3], '[语音]');
    await handle.stop();
  });

  it('feishu webhook handler rejects events with invalid verification token', async () => {
    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'correct-token',
    };
    const handle = await startPreconfiguredConnectorGateway(config);
    assert.ok(handle);

    const feishuHandler = handle.webhookHandlers.get('feishu');
    const result = await feishuHandler.handleWebhook(
      {
        header: {
          event_type: 'im.message.receive_v1',
          token: 'wrong-token',
        },
        event: {
          sender: { sender_id: { open_id: 'ou_user' } },
          message: {
            message_id: 'om_msg',
            chat_id: 'oc_chat',
            chat_type: 'p2p',
            content: JSON.stringify({ text: 'evil message' }),
            message_type: 'text',
          },
        },
      },
      {},
    );
    assert.equal(result.kind, 'error');
    if (result.kind === 'error') {
      assert.equal(result.status, 403);
    }
    await handle.stop();
  });

  it('creates gateway with feishu in websocket mode without verificationToken', async () => {
    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuConnectionMode: 'websocket',
    };
    const mockWsClient = { started: false, closed: false };
    const deps = {
      ...baseDeps,
      _wsClientFactory: () => ({
        async start() {
          mockWsClient.started = true;
        },
        close() {
          mockWsClient.closed = true;
        },
      }),
    };
    const handle = await startPreconfiguredConnectorGateway(config, deps);
    assert.ok(handle, 'Gateway should be created with websocket mode');
    assert.equal(handle.webhookHandlers.has('feishu'), false, 'Websocket mode should NOT register webhook handler');
    assert.ok(mockWsClient.started, 'Mock WSClient should have been started');
    await handle.stop();
    assert.ok(mockWsClient.closed, 'Mock WSClient should have been closed on stop');
  });

  it('feishu websocket mode still allows webhook mode when explicitly set', async () => {
    const config = {
      feishuAppId: 'test-app-id',
      feishuAppSecret: 'test-app-secret',
      feishuVerificationToken: 'test-token',
      feishuConnectionMode: 'webhook',
    };
    const handle = await startPreconfiguredConnectorGateway(config);
    assert.ok(handle);
    assert.ok(handle.webhookHandlers.has('feishu'), 'Explicit webhook mode should register webhook handler');
    await handle.stop();
  });

  it('loadConnectorGatewayConfig reads FEISHU_CONNECTION_MODE from env', async () => {
    const { loadConnectorGatewayConfig } = await import(
      '../dist/infrastructure/connectors/connector-gateway-bootstrap.js'
    );

    process.env.FEISHU_CONNECTION_MODE = 'websocket';
    const config = loadConnectorGatewayConfig();
    assert.equal(config.feishuConnectionMode, 'websocket');

    process.env.FEISHU_CONNECTION_MODE = 'webhook';
    const config2 = loadConnectorGatewayConfig();
    assert.equal(config2.feishuConnectionMode, 'webhook');

    delete process.env.FEISHU_CONNECTION_MODE;
    const config3 = loadConnectorGatewayConfig();
    assert.equal(config3.feishuConnectionMode, 'webhook', 'Should default to webhook when not set');
  });
});
