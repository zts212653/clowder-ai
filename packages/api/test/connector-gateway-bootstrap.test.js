import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { getConnectorDefinition, unregisterConnectorDefinition } from '@cat-cafe/shared';
import {
  applyConnectorGatewayAutostartPolicy,
  isPreconfiguredConnectorAutostartEnabled,
  startConnectorGateway,
} from '../dist/infrastructure/connectors/connector-gateway-bootstrap.js';
import {
  clearExternalConnectorRegistry,
  getAllExternalConnectorMeta,
} from '../dist/infrastructure/connectors/external-connector-registry.js';
import {
  clearConnectorConfigCache,
  resolveConnectorEnv,
  writeConnectorConfig,
} from '../dist/infrastructure/connectors/im-connector-config-store.js';
import { FeishuTokenManager } from '../dist/infrastructure/connectors/im-connectors/feishu/FeishuTokenManager.js';
import { TelegramAdapter } from '../dist/infrastructure/connectors/im-connectors/telegram/TelegramAdapter.js';
import { resolvePluginsDir } from '../dist/infrastructure/connectors/plugins/plugin-installer.js';

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
    assert.ok(result.pluginRegistry.has('wecom-bot'), 'WeCom Bot plugin must be registered for pre-config actions');
    await result.stop();
  });

  it('keeps WeCom Bot plugin registered after dynamic stop', async () => {
    const result = await startConnectorGateway({}, baseDeps);
    assert.ok(result.pluginRegistry.has('wecom-bot'), 'WeCom Bot plugin must exist before credentials are saved');

    await result.stopWeComBot();

    assert.ok(result.pluginRegistry.has('wecom-bot'), 'WeCom Bot plugin must remain available after disconnect');
    await result.stop();
  });

  it('deactivateConnector("wecom-bot") stops dynamic WeCom Bot stream', async () => {
    const { WeComBotAdapter } = await import(
      '../dist/infrastructure/connectors/im-connectors/wecom-bot/WeComBotAdapter.js'
    );
    const originalHydrate = WeComBotAdapter.prototype.hydrateGroupChatIds;
    const originalStart = WeComBotAdapter.prototype.startStream;
    const originalStop = WeComBotAdapter.prototype.stopStream;
    let startCalls = 0;
    let stopCalls = 0;

    WeComBotAdapter.prototype.hydrateGroupChatIds = async function stubHydrate() {};
    WeComBotAdapter.prototype.startStream = async function stubStart() {
      startCalls += 1;
    };
    WeComBotAdapter.prototype.stopStream = async function stubStop() {
      stopCalls += 1;
    };

    try {
      const handle = await startConnectorGateway({}, baseDeps);
      assert.ok(handle.pluginRegistry.has('wecom-bot'), 'WeCom Bot plugin must be registered before dynamic start');

      await handle.startWeComBotStream('bot-id', 'bot-secret');
      assert.equal(startCalls, 1, 'dynamic WeCom Bot start must open the stream');
      assert.ok(handle.adapterRegistry.has('wecom-bot'), 'dynamic start must register the live adapter');

      await handle.deactivateConnector('wecom-bot');

      assert.equal(stopCalls, 1, 'generic deactivation must stop the WeCom Bot stream');
      assert.equal(handle.adapterRegistry.has('wecom-bot'), false, 'generic deactivation must remove the live adapter');

      await handle.stop();
      assert.equal(stopCalls, 1, 'gateway stop must not stop an already-deactivated WeCom Bot stream twice');
    } finally {
      WeComBotAdapter.prototype.hydrateGroupChatIds = originalHydrate;
      WeComBotAdapter.prototype.startStream = originalStart;
      WeComBotAdapter.prototype.stopStream = originalStop;
    }
  });

  it('legacy stopWeComBot stops WeCom Bot activated through generic connector activation', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wecom-generic-stop-'));
    const { WeComBotAdapter } = await import(
      '../dist/infrastructure/connectors/im-connectors/wecom-bot/WeComBotAdapter.js'
    );
    const originalHydrate = WeComBotAdapter.prototype.hydrateGroupChatIds;
    const originalStart = WeComBotAdapter.prototype.startStream;
    const originalStop = WeComBotAdapter.prototype.stopStream;
    const previousRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const previousBotId = process.env.WECOM_BOT_ID;
    const previousSecret = process.env.WECOM_BOT_SECRET;
    let startCalls = 0;
    let stopCalls = 0;

    process.env.CAT_CAFE_CONFIG_ROOT = tempRoot;
    delete process.env.WECOM_BOT_ID;
    delete process.env.WECOM_BOT_SECRET;
    clearConnectorConfigCache();
    WeComBotAdapter.prototype.hydrateGroupChatIds = async function stubHydrate() {};
    WeComBotAdapter.prototype.startStream = async function stubStart() {
      startCalls += 1;
    };
    WeComBotAdapter.prototype.stopStream = async function stubStop() {
      stopCalls += 1;
    };

    try {
      const handle = await startConnectorGateway({}, baseDeps);
      assert.ok(
        handle.pluginRegistry.has('wecom-bot'),
        'WeCom Bot plugin must be registered before generic activation',
      );

      writeConnectorConfig(tempRoot, 'wecom-bot', [
        { name: 'WECOM_BOT_ID', value: 'typed-bot-id' },
        { name: 'WECOM_BOT_SECRET', value: 'typed-secret' },
      ]);

      await handle.activateConnector('wecom-bot');
      assert.equal(startCalls, 1, 'generic activation must start the WeCom Bot stream');

      await handle.stopWeComBot();

      assert.equal(stopCalls, 1, 'legacy stopWeComBot must stop generic-activated WeCom Bot stream');
      assert.equal(handle.adapterRegistry.has('wecom-bot'), false, 'legacy stop should remove live adapter');
      await handle.stop();
      assert.equal(stopCalls, 1, 'gateway stop must not stop an already-stopped generic WeCom Bot stream twice');
    } finally {
      if (previousRoot === undefined) delete process.env.CAT_CAFE_CONFIG_ROOT;
      else process.env.CAT_CAFE_CONFIG_ROOT = previousRoot;
      if (previousBotId === undefined) delete process.env.WECOM_BOT_ID;
      else process.env.WECOM_BOT_ID = previousBotId;
      if (previousSecret === undefined) delete process.env.WECOM_BOT_SECRET;
      else process.env.WECOM_BOT_SECRET = previousSecret;
      WeComBotAdapter.prototype.hydrateGroupChatIds = originalHydrate;
      WeComBotAdapter.prototype.startStream = originalStart;
      WeComBotAdapter.prototype.stopStream = originalStop;
      clearConnectorConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('dynamic WeCom Bot start registers adapter with StreamingOutboundHook', async () => {
    const { WeComBotAdapter } = await import(
      '../dist/infrastructure/connectors/im-connectors/wecom-bot/WeComBotAdapter.js'
    );
    const originalHydrate = WeComBotAdapter.prototype.hydrateGroupChatIds;
    const originalStart = WeComBotAdapter.prototype.startStream;
    const originalSendPlaceholder = WeComBotAdapter.prototype.sendPlaceholder;
    const originalEditMessage = WeComBotAdapter.prototype.editMessage;
    const placeholderCalls = [];

    WeComBotAdapter.prototype.hydrateGroupChatIds = async function stubHydrate() {};
    WeComBotAdapter.prototype.startStream = async function stubStart() {};
    WeComBotAdapter.prototype.sendPlaceholder = async function stubPlaceholder(chatId, text) {
      placeholderCalls.push({ chatId, text });
      return 'wecom-placeholder-1';
    };
    WeComBotAdapter.prototype.editMessage = async function stubEditMessage() {};

    const bindingStore = {
      async getByThread(threadId) {
        if (threadId !== 'thread-wecom-stream') return [];
        return [
          {
            connectorId: 'wecom-bot',
            externalChatId: 'wecom-chat-1',
            threadId,
            userId: 'owner-1',
            createdAt: Date.now(),
          },
        ];
      },
    };

    try {
      const handle = await startConnectorGateway({}, { ...baseDeps, bindingStore });
      await handle.startWeComBotStream('bot-id', 'bot-secret');
      await handle.streamingHook.onStreamStart('thread-wecom-stream', 'opus');

      assert.equal(placeholderCalls.length, 1, 'dynamic WeCom Bot adapter must receive stream placeholder');
      assert.equal(placeholderCalls[0].chatId, 'wecom-chat-1');

      await handle.stop();
    } finally {
      WeComBotAdapter.prototype.hydrateGroupChatIds = originalHydrate;
      WeComBotAdapter.prototype.startStream = originalStart;
      WeComBotAdapter.prototype.sendPlaceholder = originalSendPlaceholder;
      WeComBotAdapter.prototype.editMessage = originalEditMessage;
    }
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

  // ── F240 R4-P2: deactivateConnector preserves Weixin adapter for QR re-login ──

  it('deactivateConnector("weixin") preserves adapter in registry (QR re-login regression)', async () => {
    const handle = await startConnectorGateway({}, baseDeps);
    assert.ok(handle);

    // Weixin adapter is always created at bootstrap — even without credentials
    const adapter = handle.adapterRegistry.get('weixin');
    assert.ok(adapter, 'Weixin adapter must exist in registry at bootstrap');
    assert.strictEqual(adapter, handle.weixinAdapter, 'Registry and handle must reference same adapter');

    // Deactivate — must NOT remove adapter (it's the QR login state carrier)
    await handle.deactivateConnector('weixin');

    // Adapter still in registry — next QR confirm can inject fresh token
    assert.strictEqual(
      handle.adapterRegistry.get('weixin'),
      adapter,
      'Weixin adapter must survive deactivation for QR re-login cycle',
    );
    assert.strictEqual(handle.weixinAdapter, adapter, 'weixinAdapter ref must not change');

    await handle.stop();
  });

  it('Weixin polling handler rejects when routing fails', async () => {
    const { WeixinAdapter } = await import('../dist/infrastructure/connectors/im-connectors/weixin/WeixinAdapter.js');
    const originalStartPolling = WeixinAdapter.prototype.startPolling;
    const originalStopPolling = WeixinAdapter.prototype.stopPolling;
    let capturedHandler;

    WeixinAdapter.prototype.startPolling = function stubStartPolling(handler) {
      capturedHandler = handler;
    };
    WeixinAdapter.prototype.stopPolling = async function stubStopPolling() {};

    const deps = {
      ...baseDeps,
      messageStore: {
        async append() {
          throw new Error('route failed before append');
        },
      },
    };

    try {
      const handle = await startConnectorGateway({ weixinBotToken: 'test-token' }, deps);
      assert.equal(typeof capturedHandler, 'function', 'Weixin polling handler should be registered');

      await assert.rejects(
        () =>
          capturedHandler({
            chatId: 'wx-user-1',
            text: 'route me',
            messageId: 'wx-msg-1',
          }),
        /route failed before append/,
      );

      await handle.stop();
    } finally {
      WeixinAdapter.prototype.startPolling = originalStartPolling;
      WeixinAdapter.prototype.stopPolling = originalStopPolling;
    }
  });

  // ── F240 R5-P1: installed plugins use config store, not just process.env ──

  it('R5-P1: installed plugin reads Hub-saved config from config store at bootstrap', async () => {
    // Use isolated temp directory via CAT_CAFE_CONFIG_ROOT to avoid touching real .cat-cafe/
    const tempRoot = mkdtempSync(join(tmpdir(), 'r5-probe-'));
    const pluginId = 'test-r5-config-probe';
    const pluginDir = join(resolvePluginsDir(tempRoot), pluginId);
    const configDir = join(tempRoot, '.cat-cafe', 'im-connector-config');

    // Ensure directories exist
    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    // 1. connector.yaml — declares one required env key
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: R5 Config Probe',
        'nameEn: R5 Config Probe',
        'version: 1.0.0',
        'icon:',
        '  type: png',
        '  src: /test.png',
        "themeColor: '#FF0000'",
        'docsUrl: https://example.com',
        'config:',
        '  - envName: R5_PROBE_TOKEN',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        'steps:',
        '  - text: test',
      ].join('\n'),
    );

    // 2. index.js — plugin that stashes the env it receives via globalThis for assertion
    writeFileSync(
      join(pluginDir, 'index.js'),
      `export default {
        id: '${pluginId}',
        definition: {
          id: '${pluginId}',
          displayName: 'R5 Config Probe',
          icon: { type: 'png', src: '/test.png' },
          themeColor: '#FF0000',
          description: 'R5-P1 regression: installed plugin must use config store',
        },
        requiredEnvKeys: ['R5_PROBE_TOKEN'],
        optionalEnvKeys: [],
        isConfigured(env) { return Boolean(env.R5_PROBE_TOKEN); },
        createAdapter(ctx) {
          globalThis.__r5ProbeEnv = ctx.env;
          return { id: '${pluginId}', sendMessage() {} };
        },
      };`,
    );

    // 3. Write Hub-saved config — simulates user saving in Hub UI
    const configPath = join(configDir, `${pluginId}.json`);
    writeFileSync(configPath, JSON.stringify({ R5_PROBE_TOKEN: 'hub-saved-secret-token' }));

    // Redirect bootstrap to temp root; do NOT set R5_PROBE_TOKEN in process.env.
    // Before the fix, bootstrap read process.env (undefined) and skipped the plugin.
    const savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const savedEnvVal = process.env.R5_PROBE_TOKEN;
    process.env.CAT_CAFE_CONFIG_ROOT = tempRoot;
    delete process.env.R5_PROBE_TOKEN;

    try {
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      const handle = await startConnectorGateway({}, baseDeps);

      // The plugin should be configured via config store, not process.env
      assert.ok(
        globalThis.__r5ProbeEnv,
        'Installed plugin adapter must be created — config store value should satisfy isConfigured()',
      );
      assert.equal(
        globalThis.__r5ProbeEnv.R5_PROBE_TOKEN,
        'hub-saved-secret-token',
        'Plugin env must come from config store (.cat-cafe/im-connector-config/), not process.env',
      );

      await handle.stop();
    } finally {
      // Restore env
      if (savedConfigRoot === undefined) {
        delete process.env.CAT_CAFE_CONFIG_ROOT;
      } else {
        process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
      }
      if (savedEnvVal === undefined) {
        delete process.env.R5_PROBE_TOKEN;
      } else {
        process.env.R5_PROBE_TOKEN = savedEnvVal;
      }
      delete globalThis.__r5ProbeEnv;
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      // Remove entire temp root — no artifacts left behind
      try {
        rmSync(tempRoot, { recursive: true, force: true });
      } catch {
        /* cleanup best-effort */
      }
    }
  });

  it('loads built-in connector manifests from source tree when config root is external', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'builtin-config-root-'));
    const configDir = join(tempRoot, '.cat-cafe', 'im-connector-config');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'telegram.json'),
      JSON.stringify({ TELEGRAM_BOT_TOKEN: '123456:stored_token_abc123' }),
    );

    const savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const savedToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalStartPolling = TelegramAdapter.prototype.startPolling;
    const originalStopPolling = TelegramAdapter.prototype.stopPolling;
    let pollingStarted = 0;

    process.env.CAT_CAFE_CONFIG_ROOT = tempRoot;
    delete process.env.TELEGRAM_BOT_TOKEN;
    TelegramAdapter.prototype.startPolling = function stubStartPolling() {
      pollingStarted += 1;
    };
    TelegramAdapter.prototype.stopPolling = async function stubStopPolling() {};

    try {
      clearConnectorConfigCache();
      const handle = await startConnectorGateway({}, baseDeps);

      assert.ok(
        handle.adapterRegistry.has('telegram'),
        'built-in Telegram should use Hub-saved config even when CAT_CAFE_CONFIG_ROOT is outside the repo',
      );
      assert.equal(pollingStarted, 1, 'Telegram polling should start from stored config');

      await handle.stop();
    } finally {
      if (savedConfigRoot === undefined) {
        delete process.env.CAT_CAFE_CONFIG_ROOT;
      } else {
        process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
      }
      if (savedToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = savedToken;
      }
      TelegramAdapter.prototype.startPolling = originalStartPolling;
      TelegramAdapter.prototype.stopPolling = originalStopPolling;
      clearConnectorConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('dynamic activation preserves saved config cache for other connectors', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'activation-cache-'));
    const pluginsRoot = resolvePluginsDir(tempRoot);
    const configDir = join(tempRoot, '.cat-cafe', 'im-connector-config');
    const activationId = 'activation-cache-probe';
    const siblingId = 'sibling-cache-probe';
    const activationDir = join(pluginsRoot, activationId);
    const siblingDir = join(pluginsRoot, siblingId);
    const siblingFields = [{ envName: 'SIBLING_CACHE_TOKEN', label: 'Token', required: true, sensitive: true }];
    let handle;

    mkdirSync(activationDir, { recursive: true });
    mkdirSync(siblingDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(activationDir, 'connector.yaml'),
      [
        `id: ${activationId}`,
        'name: Activation Cache Probe',
        'nameEn: Activation Cache Probe',
        'version: 1.0.0',
        'icon:',
        '  type: png',
        '  src: /test.png',
        "themeColor: '#FF0000'",
        'docsUrl: https://example.com',
        'config:',
        '  - envName: ACTIVATION_CACHE_TOKEN',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        'steps:',
        '  - text: test',
      ].join('\n'),
    );
    writeFileSync(
      join(activationDir, 'index.js'),
      `export default {
        id: '${activationId}',
        definition: {
          id: '${activationId}',
          displayName: 'Activation Cache Probe',
          icon: { type: 'png', src: '/test.png' },
          themeColor: '#FF0000',
          description: 'activation cache regression probe',
        },
        requiredEnvKeys: ['ACTIVATION_CACHE_TOKEN'],
        optionalEnvKeys: [],
        isConfigured(env) { return Boolean(env.ACTIVATION_CACHE_TOKEN); },
        createAdapter() { return { id: '${activationId}', sendMessage() {} }; },
      };`,
    );
    writeFileSync(
      join(siblingDir, 'connector.yaml'),
      [
        `id: ${siblingId}`,
        'name: Sibling Cache Probe',
        'nameEn: Sibling Cache Probe',
        'version: 1.0.0',
        'icon:',
        '  type: png',
        '  src: /test.png',
        "themeColor: '#00AAFF'",
        'docsUrl: https://example.com',
        'config:',
        '  - envName: SIBLING_CACHE_TOKEN',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        'steps:',
        '  - text: test',
      ].join('\n'),
    );
    writeFileSync(
      join(siblingDir, 'index.js'),
      `export default {
        id: '${siblingId}',
        definition: {
          id: '${siblingId}',
          displayName: 'Sibling Cache Probe',
          icon: { type: 'png', src: '/test.png' },
          themeColor: '#00AAFF',
          description: 'sibling cache regression probe',
        },
        requiredEnvKeys: ['SIBLING_CACHE_TOKEN'],
        optionalEnvKeys: [],
        isConfigured(env) { return Boolean(env.SIBLING_CACHE_TOKEN); },
        createAdapter() { return { id: '${siblingId}', sendMessage() {} }; },
      };`,
    );
    writeFileSync(join(configDir, `${siblingId}.json`), JSON.stringify({ SIBLING_CACHE_TOKEN: 'sibling-saved' }));

    const savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const savedActivationToken = process.env.ACTIVATION_CACHE_TOKEN;
    const savedSiblingToken = process.env.SIBLING_CACHE_TOKEN;
    process.env.CAT_CAFE_CONFIG_ROOT = tempRoot;
    delete process.env.ACTIVATION_CACHE_TOKEN;
    delete process.env.SIBLING_CACHE_TOKEN;

    try {
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      handle = await startConnectorGateway({}, baseDeps);
      assert.equal(
        resolveConnectorEnv(siblingId, siblingFields).SIBLING_CACHE_TOKEN,
        'sibling-saved',
        'bootstrap must preload saved config for sibling connector',
      );

      writeFileSync(
        join(configDir, `${activationId}.json`),
        JSON.stringify({ ACTIVATION_CACHE_TOKEN: 'activation-saved' }),
      );
      await handle.activateConnector(activationId);

      assert.ok(
        handle.adapterRegistry.has(activationId),
        'dynamic activation must create the newly configured adapter',
      );
      assert.equal(
        resolveConnectorEnv(siblingId, siblingFields).SIBLING_CACHE_TOKEN,
        'sibling-saved',
        'activation must not clear saved config cache entries for other connectors',
      );
    } finally {
      if (handle) await handle.stop();
      if (savedConfigRoot === undefined) {
        delete process.env.CAT_CAFE_CONFIG_ROOT;
      } else {
        process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
      }
      if (savedActivationToken === undefined) {
        delete process.env.ACTIVATION_CACHE_TOKEN;
      } else {
        process.env.ACTIVATION_CACHE_TOKEN = savedActivationToken;
      }
      if (savedSiblingToken === undefined) {
        delete process.env.SIBLING_CACHE_TOKEN;
      } else {
        process.env.SIBLING_CACHE_TOKEN = savedSiblingToken;
      }
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps external configured metadata in sync across dynamic activate and deactivate', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'activation-configured-meta-'));
    const pluginId = 'activation-configured-meta-probe';
    const pluginDir = join(resolvePluginsDir(tempRoot), pluginId);
    const configDir = join(tempRoot, '.cat-cafe', 'im-connector-config');
    let handle;

    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Activation Configured Meta Probe',
        'nameEn: Activation Configured Meta Probe',
        'version: 1.0.0',
        'source: external',
        'icon:',
        '  type: png',
        '  src: /test.png',
        "themeColor: '#336699'",
        'docsUrl: https://example.com/activation-configured-meta-probe',
        'config:',
        '  - envName: ACTIVATION_CONFIGURED_META_TOKEN',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        'steps:',
        '  - text: test',
      ].join('\n'),
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      `export default {
        id: '${pluginId}',
        definition: {
          id: '${pluginId}',
          displayName: 'Activation Configured Meta Probe',
          icon: { type: 'png', src: '/test.png' },
          themeColor: '#336699',
          description: 'configured metadata dynamic lifecycle regression probe',
        },
        requiredEnvKeys: ['ACTIVATION_CONFIGURED_META_TOKEN'],
        optionalEnvKeys: [],
        isConfigured(env) { return Boolean(env.ACTIVATION_CONFIGURED_META_TOKEN); },
        createAdapter() { return { id: '${pluginId}', sendMessage() {} }; },
      };`,
    );

    const savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const savedToken = process.env.ACTIVATION_CONFIGURED_META_TOKEN;
    process.env.CAT_CAFE_CONFIG_ROOT = tempRoot;
    delete process.env.ACTIVATION_CONFIGURED_META_TOKEN;

    try {
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      handle = await startConnectorGateway({}, baseDeps);
      assert.equal(
        getAllExternalConnectorMeta().find((meta) => meta.id === pluginId)?.configured,
        false,
        'unconfigured external plugin should start with configured=false metadata',
      );

      writeFileSync(
        join(configDir, `${pluginId}.json`),
        JSON.stringify({ ACTIVATION_CONFIGURED_META_TOKEN: 'saved-token' }),
      );
      await handle.activateConnector(pluginId);
      assert.equal(
        getAllExternalConnectorMeta().find((meta) => meta.id === pluginId)?.configured,
        true,
        'successful dynamic activation must refresh external configured metadata',
      );

      writeFileSync(join(configDir, `${pluginId}.json`), JSON.stringify({ ACTIVATION_CONFIGURED_META_TOKEN: null }));
      await handle.deactivateConnector(pluginId);
      assert.equal(
        getAllExternalConnectorMeta().find((meta) => meta.id === pluginId)?.configured,
        false,
        'dynamic deactivation after credential clear must refresh external configured metadata',
      );
    } finally {
      if (handle) await handle.stop();
      if (savedConfigRoot === undefined) {
        delete process.env.CAT_CAFE_CONFIG_ROOT;
      } else {
        process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
      }
      if (savedToken === undefined) {
        delete process.env.ACTIVATION_CONFIGURED_META_TOKEN;
      } else {
        process.env.ACTIVATION_CONFIGURED_META_TOKEN = savedToken;
      }
      unregisterConnectorDefinition(pluginId);
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects deactivation when the inbound stop handle fails but clears runtime registries once', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'deactivation-stop-failure-'));
    const pluginId = 'deactivation-stop-failure-probe';
    const pluginDir = join(resolvePluginsDir(tempRoot), pluginId);
    const configDir = join(tempRoot, '.cat-cafe', 'im-connector-config');
    const stopCountFile = join(tempRoot, 'stop-count.txt');
    let handle;

    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Deactivation Stop Failure Probe',
        'nameEn: Deactivation Stop Failure Probe',
        'version: 1.0.0',
        'source: external',
        'icon:',
        '  type: png',
        '  src: /test.png',
        "themeColor: '#336699'",
        'docsUrl: https://example.com/deactivation-stop-failure-probe',
        'config:',
        '  - envName: DEACTIVATION_STOP_FAILURE_TOKEN',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        'steps:',
        '  - text: test',
      ].join('\n'),
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      `import { appendFileSync } from 'node:fs';

      export default {
        id: '${pluginId}',
        definition: {
          id: '${pluginId}',
          displayName: 'Deactivation Stop Failure Probe',
          icon: { type: 'png', src: '/test.png' },
          themeColor: '#336699',
          description: 'deactivation stop failure regression probe',
        },
        requiredEnvKeys: ['DEACTIVATION_STOP_FAILURE_TOKEN'],
        optionalEnvKeys: [],
        isConfigured(env) { return Boolean(env.DEACTIVATION_STOP_FAILURE_TOKEN); },
        createAdapter() { return { id: '${pluginId}', sendMessage() {} }; },
        async startInbound() {
          return {
            async stop() {
              appendFileSync(process.env.DEACTIVATION_STOP_FAILURE_COUNT_FILE, 'x');
              throw new Error('stop failed');
            },
          };
        },
      };`,
    );
    writeFileSync(
      join(configDir, `${pluginId}.json`),
      JSON.stringify({ DEACTIVATION_STOP_FAILURE_TOKEN: 'saved-token' }),
    );

    const savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const savedToken = process.env.DEACTIVATION_STOP_FAILURE_TOKEN;
    const savedCountFile = process.env.DEACTIVATION_STOP_FAILURE_COUNT_FILE;
    process.env.CAT_CAFE_CONFIG_ROOT = tempRoot;
    process.env.DEACTIVATION_STOP_FAILURE_COUNT_FILE = stopCountFile;
    delete process.env.DEACTIVATION_STOP_FAILURE_TOKEN;

    try {
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      handle = await startConnectorGateway({}, baseDeps);
      assert.equal(handle.adapterRegistry.has(pluginId), true, 'configured external connector should start live');

      await assert.rejects(() => handle.deactivateConnector(pluginId), /stop failed/);

      assert.equal(
        handle.adapterRegistry.has(pluginId),
        false,
        'failed deactivation must still remove the adapter from runtime registries',
      );
      assert.equal(readFileSync(stopCountFile, 'utf8'), 'x', 'deactivation should call stop exactly once');

      await handle.stop();
      assert.equal(readFileSync(stopCountFile, 'utf8'), 'x', 'gateway shutdown must not double-call failed stop');
      handle = null;
    } finally {
      if (handle) await handle.stop().catch(() => {});
      if (savedConfigRoot === undefined) {
        delete process.env.CAT_CAFE_CONFIG_ROOT;
      } else {
        process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
      }
      if (savedToken === undefined) {
        delete process.env.DEACTIVATION_STOP_FAILURE_TOKEN;
      } else {
        process.env.DEACTIVATION_STOP_FAILURE_TOKEN = savedToken;
      }
      if (savedCountFile === undefined) {
        delete process.env.DEACTIVATION_STOP_FAILURE_COUNT_FILE;
      } else {
        process.env.DEACTIVATION_STOP_FAILURE_COUNT_FILE = savedCountFile;
      }
      unregisterConnectorDefinition(pluginId);
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('normalizes installed external plugin icon definitions before registry and routing', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'external-icon-normalization-'));
    const pluginId = 'icon-normalization-probe';
    const pluginDir = join(resolvePluginsDir(tempRoot), pluginId);
    const messages = [];
    let handle;

    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Icon Normalization Probe',
        'nameEn: Icon Normalization Probe',
        'version: 1.0.0',
        'source: external',
        'icon:',
        '  type: svg',
        '  src: icon.svg',
        "themeColor: '#336699'",
        'docsUrl: https://example.com/icon-normalization-probe',
        'config: []',
        'steps:',
        '  - text: test',
      ].join('\n'),
    );
    writeFileSync(join(pluginDir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    writeFileSync(
      join(pluginDir, 'index.js'),
      `export default {
        id: '${pluginId}',
        definition: {
          id: '${pluginId}',
          displayName: 'Icon Normalization Probe',
          icon: { type: 'svg', src: 'icon.svg' },
          themeColor: '#336699',
          description: 'external icon normalization regression probe',
        },
        requiredEnvKeys: [],
        optionalEnvKeys: [],
        isConfigured() { return true; },
        createAdapter() { return { id: '${pluginId}', sendMessage() {} }; },
        async startInbound(_adapter, onMessage) {
          await onMessage({
            chatId: 'external-icon-chat',
            text: 'hello from icon probe',
            messageId: 'external-icon-message-1',
            chatType: 'p2p',
          });
          return { async stop() {} };
        },
      };`,
    );

    const savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = tempRoot;

    const deps = {
      ...baseDeps,
      messageStore: {
        async append(input) {
          const msg = { id: `msg-${messages.length + 1}`, ...input };
          messages.push(msg);
          return msg;
        },
      },
    };

    try {
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      handle = await startConnectorGateway({}, deps);

      const expectedIconUrl = `/api/connectors/plugins/${encodeURIComponent(pluginId)}/icon`;
      assert.equal(
        getConnectorDefinition(pluginId)?.icon.src,
        expectedIconUrl,
        'runtime connector definition must expose a browser-fetchable plugin icon URL',
      );
      assert.equal(messages.length, 1, 'plugin inbound startup should route one probe message');
      assert.equal(
        messages[0].source.icon,
        expectedIconUrl,
        'routed connector messages must use the normalized plugin icon URL',
      );
    } finally {
      if (handle) await handle.stop();
      if (savedConfigRoot === undefined) {
        delete process.env.CAT_CAFE_CONFIG_ROOT;
      } else {
        process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
      }
      unregisterConnectorDefinition(pluginId);
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('removes external metadata when an installed plugin fails to load on gateway rebuild', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'stale-external-registry-'));
    const pluginId = 'stale-registry-probe';
    const pluginDir = join(resolvePluginsDir(tempRoot), pluginId);
    let handle;

    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Stale Registry Probe',
        'nameEn: Stale Registry Probe',
        'version: 1.0.0',
        'source: external',
        'icon:',
        '  type: png',
        '  src: /test.png',
        "themeColor: '#336699'",
        'docsUrl: https://example.com/stale-registry-probe',
        'config: []',
        'steps:',
        '  - text: test',
      ].join('\n'),
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      `export default {
        id: '${pluginId}',
        definition: {
          id: '${pluginId}',
          displayName: 'Stale Registry Probe',
          icon: { type: 'png', src: '/test.png' },
          themeColor: '#336699',
          description: 'valid first version',
        },
        requiredEnvKeys: [],
        optionalEnvKeys: [],
        isConfigured() { return true; },
        createAdapter() { return { id: '${pluginId}', sendMessage() {} }; },
      };`,
    );

    const savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    process.env.CAT_CAFE_CONFIG_ROOT = tempRoot;

    try {
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      handle = await startConnectorGateway({}, baseDeps);
      assert.ok(
        getAllExternalConnectorMeta().some((meta) => meta.id === pluginId && meta.configured === true),
        'valid first load must register external metadata',
      );
      await handle.stop();
      handle = null;

      writeFileSync(
        join(pluginDir, 'index.js'),
        `export default {
          id: '${pluginId}',
          definition: { id: '${pluginId}' },
        };`,
      );

      handle = await startConnectorGateway({}, baseDeps);
      assert.equal(
        getAllExternalConnectorMeta().some((meta) => meta.id === pluginId),
        false,
        'failed reload must not leave stale external metadata visible in Hub status',
      );
    } finally {
      if (handle) await handle.stop();
      if (savedConfigRoot === undefined) {
        delete process.env.CAT_CAFE_CONFIG_ROOT;
      } else {
        process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
      }
      unregisterConnectorDefinition(pluginId);
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rolls back dynamic activation state when inbound startup fails', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'activation-rollback-'));
    const pluginId = 'activation-rollback-probe';
    const pluginDir = join(resolvePluginsDir(tempRoot), pluginId);
    const configDir = join(tempRoot, '.cat-cafe', 'im-connector-config');
    let handle;

    mkdirSync(pluginDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Activation Rollback Probe',
        'nameEn: Activation Rollback Probe',
        'version: 1.0.0',
        'icon:',
        '  type: png',
        '  src: /test.png',
        "themeColor: '#336699'",
        'docsUrl: https://example.com',
        'config:',
        '  - envName: ACTIVATION_ROLLBACK_TOKEN',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        'steps:',
        '  - text: test',
      ].join('\n'),
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      `export default {
        id: '${pluginId}',
        definition: {
          id: '${pluginId}',
          displayName: 'Activation Rollback Probe',
          icon: { type: 'png', src: '/test.png' },
          themeColor: '#336699',
          description: 'activation rollback regression probe',
        },
        requiredEnvKeys: ['ACTIVATION_ROLLBACK_TOKEN'],
        optionalEnvKeys: [],
        isConfigured(env) { return Boolean(env.ACTIVATION_ROLLBACK_TOKEN); },
        createAdapter() { return { id: '${pluginId}', sendMessage() {} }; },
        createWebhookHandler() {
          return { async handleWebhook() { return { kind: 'skipped' }; } };
        },
        async startInbound() {
          throw new Error('simulated inbound startup failure');
        },
      };`,
    );

    const savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const savedToken = process.env.ACTIVATION_ROLLBACK_TOKEN;
    process.env.CAT_CAFE_CONFIG_ROOT = tempRoot;
    delete process.env.ACTIVATION_ROLLBACK_TOKEN;

    try {
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      handle = await startConnectorGateway({}, baseDeps);
      assert.equal(handle.adapterRegistry.has(pluginId), false, 'unconfigured plugin must not start at bootstrap');

      writeFileSync(join(configDir, `${pluginId}.json`), JSON.stringify({ ACTIVATION_ROLLBACK_TOKEN: 'saved-token' }));
      await assert.rejects(
        () => handle.activateConnector(pluginId),
        /simulated inbound startup failure/,
        'activation must surface inbound startup failures',
      );

      assert.equal(handle.adapterRegistry.has(pluginId), false, 'failed activation must not publish adapter state');
      assert.equal(handle.webhookHandlers.has(pluginId), false, 'failed activation must not publish webhook state');
    } finally {
      if (handle) await handle.stop();
      if (savedConfigRoot === undefined) {
        delete process.env.CAT_CAFE_CONFIG_ROOT;
      } else {
        process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
      }
      if (savedToken === undefined) {
        delete process.env.ACTIVATION_ROLLBACK_TOKEN;
      } else {
        process.env.ACTIVATION_ROLLBACK_TOKEN = savedToken;
      }
      unregisterConnectorDefinition(pluginId);
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('rejects dynamic activation when stored config is still incomplete', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'activation-incomplete-'));
    const pluginId = 'activation-incomplete-probe';
    const pluginDir = join(resolvePluginsDir(tempRoot), pluginId);
    let handle;

    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'connector.yaml'),
      [
        `id: ${pluginId}`,
        'name: Activation Incomplete Probe',
        'nameEn: Activation Incomplete Probe',
        'version: 1.0.0',
        'icon:',
        '  type: png',
        '  src: /test.png',
        "themeColor: '#336699'",
        'docsUrl: https://example.com',
        'config:',
        '  - envName: ACTIVATION_INCOMPLETE_TOKEN',
        '    label: Token',
        '    sensitive: true',
        '    required: true',
        'steps:',
        '  - text: test',
      ].join('\n'),
    );
    writeFileSync(
      join(pluginDir, 'index.js'),
      `export default {
        id: '${pluginId}',
        definition: {
          id: '${pluginId}',
          displayName: 'Activation Incomplete Probe',
          icon: { type: 'png', src: '/test.png' },
          themeColor: '#336699',
          description: 'activation incomplete regression probe',
        },
        requiredEnvKeys: ['ACTIVATION_INCOMPLETE_TOKEN'],
        optionalEnvKeys: [],
        isConfigured(env) { return Boolean(env.ACTIVATION_INCOMPLETE_TOKEN); },
        createAdapter() { throw new Error('adapter must not be created from incomplete config'); },
      };`,
    );

    const savedConfigRoot = process.env.CAT_CAFE_CONFIG_ROOT;
    const savedToken = process.env.ACTIVATION_INCOMPLETE_TOKEN;
    process.env.CAT_CAFE_CONFIG_ROOT = tempRoot;
    delete process.env.ACTIVATION_INCOMPLETE_TOKEN;

    try {
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      handle = await startConnectorGateway({}, baseDeps);
      assert.equal(handle.adapterRegistry.has(pluginId), false, 'unconfigured plugin must not start at bootstrap');

      await assert.rejects(
        () => handle.activateConnector(pluginId),
        /not configured/i,
        'activation must surface incomplete config instead of reporting success',
      );
      assert.equal(handle.adapterRegistry.has(pluginId), false, 'incomplete activation must not publish adapter state');
    } finally {
      if (handle) await handle.stop();
      if (savedConfigRoot === undefined) {
        delete process.env.CAT_CAFE_CONFIG_ROOT;
      } else {
        process.env.CAT_CAFE_CONFIG_ROOT = savedConfigRoot;
      }
      if (savedToken === undefined) {
        delete process.env.ACTIVATION_INCOMPLETE_TOKEN;
      } else {
        process.env.ACTIVATION_INCOMPLETE_TOKEN = savedToken;
      }
      unregisterConnectorDefinition(pluginId);
      clearExternalConnectorRegistry();
      clearConnectorConfigCache();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('index.ts wires legacy connector action callbacks into connectorHubOpts', () => {
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    assert.ok(
      source.includes(
        '(connectorHubOpts as { startWeixinPolling?: () => void }).startWeixinPolling = handle.startWeixinPolling',
      ),
      'wireGatewayHooks must pass startWeixinPolling to legacy Hub routes',
    );
    assert.ok(
      source.includes(').startWeComBotStream = handle.startWeComBotStream'),
      'wireGatewayHooks must pass startWeComBotStream to legacy Hub routes',
    );
    assert.ok(
      source.includes(
        '(connectorHubOpts as { stopWeComBot?: () => Promise<void> }).stopWeComBot = handle.stopWeComBot',
      ),
      'wireGatewayHooks must pass stopWeComBot to legacy Hub routes',
    );
    assert.ok(
      source.includes('function syncConnectorWebhookHandlers('),
      'wireGatewayHooks must centralize webhook handler map synchronization',
    );
    assert.ok(
      source.includes('await handle.activateConnector(connectorId)') &&
        source.includes('syncConnectorWebhookHandlers(handle)'),
      'live connector activation must refresh the shared webhook route handler map',
    );
  });
});
