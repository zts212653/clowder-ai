import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LimbAccessPolicy } from '../dist/domains/limb/LimbAccessPolicy.js';
import { LimbActionLog } from '../dist/domains/limb/LimbActionLog.js';
import { LimbLeaseManager } from '../dist/domains/limb/LimbLeaseManager.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import { loadLimbDeclaration } from '../dist/domains/limb/limb-yaml-loader.js';
import { WeChatVisibleReaderArmStore } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderArmStore.js';
import { WeChatVisibleReaderLimbNode } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderLimbNode.js';
import { WeChatVisibleReaderMetrics } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderMetrics.js';

const limbPath = fileURLToPath(
  new URL('../src/plugins/wechat-visible-reader/limbs/wechat-visible-reader.yml', import.meta.url),
);

describe('wechat named-conversation live contract', () => {
  it('returns OCR body to the invoking cat without copying it into action logs', async () => {
    const privateFragment = 'PRIVATE_NAMED_CONVERSATION_BODY';
    const recentResult = {
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
      messageUnits: [
        {
          blockType: 'text',
          isPartial: false,
          text: privateFragment,
          bbox: { x: 0.4, y: 0.4, width: 0.2, height: 0.05 },
          ocrConfidence: 0.99,
          layoutConfidence: 0.96,
          presumedSender: 'other',
          blockHash: 'a'.repeat(64),
        },
      ],
      totalChars: privateFragment.length,
      truncated: false,
      warnings: ['named_conversation'],
    };
    const runner = {
      read: async () => recentResult,
      readConversationRecent: async () => recentResult,
      probe: async () => ({ ok: true }),
      navigationSpike: async () => ({ ok: true }),
    };
    const node = new WeChatVisibleReaderLimbNode({
      declaration: loadLimbDeclaration(limbPath),
      armStore: new WeChatVisibleReaderArmStore(),
      metrics: new WeChatVisibleReaderMetrics(),
      runner,
      platform: 'darwin',
    });
    const actionLog = new LimbActionLog();
    const registry = new LimbRegistry();
    registry.setDeps({
      accessPolicy: new LimbAccessPolicy(),
      leaseManager: new LimbLeaseManager(),
      actionLog,
    });
    await registry.register(node);

    const result = await registry.invoke(
      node.nodeId,
      'wechat_visible_reader.read_conversation_recent',
      {
        contact: '测试联系人',
        limit: 30,
        acknowledgeUiNavigation: true,
        acknowledgeMayMarkRead: true,
      },
      {
        catId: 'codex-sol',
        invocationId: 'invocation-1',
        userId: 'owner-user',
        threadId: 'thread-f265',
        userMessageId: 'message-1',
      },
    );

    assert.equal(result.success, true);
    assert.match(JSON.stringify(result.data), new RegExp(privateFragment));
    const entries = actionLog.getByNode(node.nodeId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'completed');
    assert.doesNotMatch(JSON.stringify(entries), new RegExp(privateFragment));
  });
});
