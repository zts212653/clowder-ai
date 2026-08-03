import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWeChatVisibleReaderHandlers } from '../dist/plugins/wechat-visible-reader/handlers.js';
import { WeChatVisibleReaderArmStore } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderArmStore.js';
import { WeChatVisibleReaderMetrics } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderMetrics.js';

function recentSuccess() {
  return {
    ok: true,
    targetHeader: '测试联系人',
    targetHeaderMatched: true,
    restore: {
      conversationRestored: true,
      scrollAnchorRestored: true,
      frontApplicationRestored: true,
    },
    captureId: 'capture-recent-1',
    capturedAt: '2026-07-19T05:00:00.000Z',
    source: {
      bundleId: 'com.tencent.xinWeChat',
      wechatVersion: '4.1.11',
      windowSize: { width: 1158, height: 769 },
    },
    layout: {
      profileId: 'wechat-4.1.11-main',
      confidence: 0.96,
      bodyRegion: { x: 0.39, y: 0.1, width: 0.59, height: 0.63 },
    },
    messageUnits: [],
    totalChars: 0,
    truncated: false,
    warnings: ['named_conversation'],
  };
}

function makeHandlers() {
  const calls = { recent: [], visible: [] };
  const armStore = new WeChatVisibleReaderArmStore();
  const runner = {
    read: async (options) => {
      calls.visible.push(options);
      return recentSuccess();
    },
    readConversationRecent: async (options) => {
      calls.recent.push(options);
      return recentSuccess();
    },
    probe: async () => ({ ok: true }),
    navigationSpike: async () => ({ ok: true }),
  };
  const handlers = createWeChatVisibleReaderHandlers({
    armStore,
    metrics: new WeChatVisibleReaderMetrics(),
    runner,
  });
  return { handlers, calls, armStore };
}

const trustedInvocation = {
  catId: 'codex-sol',
  invocationId: 'invocation-1',
  userId: 'owner-user',
  threadId: 'thread-f265',
  userMessageId: 'owner-message-1',
};

const validParams = {
  contact: ' 测试联系人 ',
  limit: 30,
  acknowledgeUiNavigation: true,
  acknowledgeMayMarkRead: true,
};

describe('wechat read_conversation_recent handler', () => {
  it('requires trusted owner-message provenance before any native UI action', async () => {
    const { handlers, calls } = makeHandlers();
    const handler = handlers['wechat-visible-reader:read_conversation_recent'];

    for (const invocation of [undefined, { ...trustedInvocation, userMessageId: undefined }]) {
      const result = await handler(validParams, {
        pluginConfig: {},
        invocation,
      });
      assert.equal(result.success, true);
      assert.equal(result.data.ok, false);
      assert.equal(result.data.error.code, 'authorization_required');
    }
    assert.equal(calls.recent.length, 0);
  });

  it('requires both explicit one-shot side-effect acknowledgements', async () => {
    const { handlers, calls } = makeHandlers();
    const handler = handlers['wechat-visible-reader:read_conversation_recent'];

    for (const missing of ['acknowledgeUiNavigation', 'acknowledgeMayMarkRead']) {
      const params = { ...validParams };
      delete params[missing];
      const result = await handler(params, { pluginConfig: {}, invocation: trustedInvocation });
      assert.equal(result.data.error.code, 'authorization_required');
    }
    assert.equal(calls.recent.length, 0);
  });

  it('rejects invalid contacts and limits before starting navigation', async () => {
    const { handlers, calls } = makeHandlers();
    const handler = handlers['wechat-visible-reader:read_conversation_recent'];

    for (const params of [
      { ...validParams, contact: '' },
      { ...validParams, contact: 'bad\ncontact' },
      { ...validParams, limit: 0 },
      { ...validParams, limit: 31 },
      { ...validParams, limit: 1.5 },
    ]) {
      const result = await handler(params, { pluginConfig: {}, invocation: trustedInvocation });
      assert.equal(result.data.error.code, 'navigation_failed');
    }
    assert.equal(calls.recent.length, 0);
  });

  it('uses one owner message as bounded consent without requiring the passive arm', async () => {
    const { handlers, calls, armStore } = makeHandlers();
    const handler = handlers['wechat-visible-reader:read_conversation_recent'];
    assert.equal(armStore.isArmed(), false);

    const result = await handler(validParams, { pluginConfig: {}, invocation: trustedInvocation });

    assert.equal(result.success, true);
    assert.deepEqual(result.data, recentSuccess());
    assert.deepEqual(calls.recent, [{ contact: '测试联系人', limit: 30 }]);
  });
});
