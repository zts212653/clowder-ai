import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startConnectorGateway } from '../dist/infrastructure/connectors/connector-gateway-bootstrap.js';

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
          context: { open_chat_id: 'oc_chat_card' },
        },
      },
      {},
    );

    assert.equal(result.kind, 'processed');
    assert.equal(triggerCalls.length, 1, 'card action should trigger cat invocation');
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
});
