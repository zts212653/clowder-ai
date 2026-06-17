import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FeishuTokenManager } from '../dist/infrastructure/connectors/adapters/FeishuTokenManager.js';
import { TelegramAdapter } from '../dist/infrastructure/connectors/adapters/TelegramAdapter.js';
import {
  applyConnectorGatewayAutostartPolicy,
  isPreconfiguredConnectorAutostartEnabled,
  startConnectorGateway,
} from '../dist/infrastructure/connectors/connector-gateway-bootstrap.js';

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
    const result = await startConnectorGateway(config, baseDeps);
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
    const handle = await startConnectorGateway(config, baseDeps);
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
    const handle = await startConnectorGateway(config, baseDeps);
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
    const handle = await startConnectorGateway(config, deps);
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
    const handle = await startConnectorGateway(config, baseDeps);
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
    const handle = await startConnectorGateway(config, deps);
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
      const handle = await startConnectorGateway({ telegramBotToken: 'sk-community-openai-api-key' }, deps);
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
      true,
      'runtime worktree production launches carry the runtime-root marker',
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

  it('scrubs preconfigured IM credentials for dev and alpha while preserving runtime production config', () => {
    const rawConfig = {
      telegramBotToken: '123456:ABC-DEF-tokenfull',
      feishuAppId: 'cli_test',
      feishuAppSecret: 'feishu-secret',
      feishuVerificationToken: 'verify-token',
      feishuBotOpenId: 'ou_bot',
      feishuAdminOpenIds: 'ou_admin',
      feishuConnectionMode: 'websocket',
      dingtalkAppKey: 'ding-key',
      dingtalkAppSecret: 'ding-secret',
      weixinBotToken: 'weixin-token',
      wecomBotId: 'wecom-bot',
      wecomBotSecret: 'wecom-secret',
      wecomCorpId: 'ww_corp',
      wecomAgentId: '1000002',
      wecomAgentSecret: 'agent-secret',
      wecomToken: 'wecom-token',
      wecomEncodingAesKey: 'a'.repeat(43),
      xiaoyiAk: 'xiaoyi-ak',
      xiaoyiSk: 'xiaoyi-sk',
      xiaoyiAgentId: 'xiaoyi-agent',
      coCreatorUserId: 'owner-1',
      whisperUrl: 'http://127.0.0.1:9881',
      connectorMediaDir: './data/connector-media',
    };

    const devConfig = applyConnectorGatewayAutostartPolicy(rawConfig, { NODE_ENV: 'development' });
    assert.deepEqual(
      {
        telegramBotToken: devConfig.telegramBotToken,
        feishuAppId: devConfig.feishuAppId,
        feishuAppSecret: devConfig.feishuAppSecret,
        feishuVerificationToken: devConfig.feishuVerificationToken,
        feishuBotOpenId: devConfig.feishuBotOpenId,
        feishuAdminOpenIds: devConfig.feishuAdminOpenIds,
        dingtalkAppKey: devConfig.dingtalkAppKey,
        dingtalkAppSecret: devConfig.dingtalkAppSecret,
        weixinBotToken: devConfig.weixinBotToken,
        wecomBotId: devConfig.wecomBotId,
        wecomBotSecret: devConfig.wecomBotSecret,
        wecomCorpId: devConfig.wecomCorpId,
        wecomAgentId: devConfig.wecomAgentId,
        wecomAgentSecret: devConfig.wecomAgentSecret,
        wecomToken: devConfig.wecomToken,
        wecomEncodingAesKey: devConfig.wecomEncodingAesKey,
        xiaoyiAk: devConfig.xiaoyiAk,
        xiaoyiSk: devConfig.xiaoyiSk,
        xiaoyiAgentId: devConfig.xiaoyiAgentId,
      },
      {
        telegramBotToken: undefined,
        feishuAppId: undefined,
        feishuAppSecret: undefined,
        feishuVerificationToken: undefined,
        feishuBotOpenId: undefined,
        feishuAdminOpenIds: undefined,
        dingtalkAppKey: undefined,
        dingtalkAppSecret: undefined,
        weixinBotToken: undefined,
        wecomBotId: undefined,
        wecomBotSecret: undefined,
        wecomCorpId: undefined,
        wecomAgentId: undefined,
        wecomAgentSecret: undefined,
        wecomToken: undefined,
        wecomEncodingAesKey: undefined,
        xiaoyiAk: undefined,
        xiaoyiSk: undefined,
        xiaoyiAgentId: undefined,
      },
    );
    assert.equal(devConfig.coCreatorUserId, 'owner-1');
    assert.equal(devConfig.whisperUrl, 'http://127.0.0.1:9881');
    assert.equal(devConfig.connectorMediaDir, './data/connector-media');

    const directProductionConfig = applyConnectorGatewayAutostartPolicy(rawConfig, { NODE_ENV: 'production' });
    assert.equal(
      directProductionConfig.weixinBotToken,
      undefined,
      'direct/debug production-mode starts must still fail closed without a runtime marker',
    );

    const runtimeProductionConfig = applyConnectorGatewayAutostartPolicy(rawConfig, {
      NODE_ENV: 'production',
      CAT_CAFE_RUNTIME_ROOT: '/tmp/cat-cafe-runtime',
    });
    assert.equal(runtimeProductionConfig.weixinBotToken, 'weixin-token');
    assert.equal(runtimeProductionConfig.telegramBotToken, '123456:ABC-DEF-tokenfull');
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
    const handle = await startConnectorGateway(config, deps);
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
    const handle = await startConnectorGateway(config, {
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
    const handle = await startConnectorGateway(config, deps);
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
    const handle = await startConnectorGateway(config, deps);
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
    const handle = await startConnectorGateway(config, baseDeps);
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
    const handle = await startConnectorGateway(config, deps);
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
    const handle = await startConnectorGateway(config, baseDeps);
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
