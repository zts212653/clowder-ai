import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LimbAccessPolicy } from '../dist/domains/limb/LimbAccessPolicy.js';
import { LimbActionLog } from '../dist/domains/limb/LimbActionLog.js';
import { LimbLeaseManager } from '../dist/domains/limb/LimbLeaseManager.js';
import { LimbRegistry } from '../dist/domains/limb/LimbRegistry.js';
import { loadLimbDeclaration } from '../dist/domains/limb/limb-yaml-loader.js';
import { registerWeChatVisibleReaderLimbFactory } from '../dist/plugins/wechat-visible-reader/factory.js';
import { WeChatVisibleReaderArmStore } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderArmStore.js';
import { WeChatVisibleReaderLimbNode } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderLimbNode.js';
import { WeChatVisibleReaderMetrics } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderMetrics.js';

const limbPath = fileURLToPath(
  new URL('../src/plugins/wechat-visible-reader/limbs/wechat-visible-reader.yml', import.meta.url),
);

function successfulRead() {
  return {
    ok: true,
    captureId: 'capture-1',
    capturedAt: '2026-07-17T04:00:00.000Z',
    source: {
      bundleId: 'com.tencent.xinWeChat',
      wechatVersion: '4.1.11',
      windowSize: { width: 1158, height: 769 },
    },
    layout: {
      profileId: 'wechat-4.1.11-main',
      confidence: 0.96,
      bodyRegion: { x: 0.28, y: 0.22, width: 0.7, height: 0.68 },
    },
    messageUnits: [],
    totalChars: 0,
    truncated: false,
    warnings: ['visible_page_only'],
  };
}

function makeNode({ armed = false, platform = 'darwin', readResult = successfulRead(), probeResult } = {}) {
  const armStore = new WeChatVisibleReaderArmStore();
  const metrics = new WeChatVisibleReaderMetrics();
  if (armed) armStore.arm({ operator: 'owner-user', minutes: 10 });
  const calls = { read: [], recent: [], probe: 0 };
  const runner = {
    read: async (options) => {
      calls.read.push(options);
      return readResult;
    },
    readConversationRecent: async (options) => {
      calls.recent.push(options);
      return {
        ...readResult,
        targetHeader: options.contact,
        targetHeaderMatched: true,
        restore: {
          conversationRestored: true,
          scrollAnchorRestored: true,
          frontApplicationRestored: true,
        },
      };
    },
    navigationSpike: async () => ({ ok: true }),
    probe: async () => {
      calls.probe += 1;
      return (
        probeResult ?? {
          ok: true,
          wechatVersion: '4.1.11',
          profileId: 'wechat-4.1.11-main',
          windowSize: { width: 1158, height: 769 },
        }
      );
    },
  };
  const node = new WeChatVisibleReaderLimbNode({
    declaration: loadLimbDeclaration(limbPath),
    armStore,
    metrics,
    runner,
    platform,
  });
  return { node, armStore, calls, metrics };
}

describe('WeChatVisibleReaderLimbNode', () => {
  it('registers one Darwin-only concrete factory under the plugin id', async () => {
    const armStore = new WeChatVisibleReaderArmStore();
    const metrics = new WeChatVisibleReaderMetrics();
    const runner = {
      read: async () => successfulRead(),
      probe: async () => ({
        ok: true,
        wechatVersion: '4.1.11',
        profileId: 'wechat-4.1.11-main',
        windowSize: { width: 1158, height: 769 },
      }),
    };
    const registry = new Map();

    registerWeChatVisibleReaderLimbFactory(registry, { armStore, metrics, runner, platform: 'darwin' });

    assert.deepEqual([...registry.keys()], ['wechat-visible-reader']);
    const node = await registry.get('wechat-visible-reader')(limbPath, {});
    assert.equal(node.nodeId, 'wechat-visible-reader-mac');

    const unsupportedRegistry = new Map();
    registerWeChatVisibleReaderLimbFactory(unsupportedRegistry, { armStore, metrics, runner, platform: 'linux' });
    await assert.rejects(unsupportedRegistry.get('wechat-visible-reader')(limbPath, {}), /only on macOS/);
  });

  it('refuses to create a discoverable node when the native probe is unavailable', async () => {
    const armStore = new WeChatVisibleReaderArmStore();
    const metrics = new WeChatVisibleReaderMetrics();
    const runner = {
      read: async () => successfulRead(),
      probe: async () => ({
        ok: false,
        error: { code: 'wechat_not_running', userAction: '请先启动微信。' },
      }),
    };
    const registry = new Map();
    registerWeChatVisibleReaderLimbFactory(registry, { armStore, metrics, runner, platform: 'darwin' });

    await assert.rejects(
      registry.get('wechat-visible-reader')(limbPath, {}),
      /WeChat visible reader unavailable: wechat_not_running/,
    );
  });

  it('declares separate passive and owner-authorized navigation capabilities', () => {
    const declaration = loadLimbDeclaration(limbPath);

    assert.equal(declaration.nodeId, 'wechat-visible-reader-mac');
    assert.equal(declaration.platform, 'macos');
    assert.deepEqual(declaration.capabilities, [
      {
        cap: 'visible_conversation_read',
        commands: ['wechat_visible_reader.read_visible_conversation'],
        authLevel: 'leased',
      },
      {
        cap: 'named_conversation_read',
        commands: ['wechat_visible_reader.read_conversation_recent'],
        authLevel: 'leased',
      },
    ]);
    const command = declaration.commands['wechat_visible_reader.read_visible_conversation'];
    assert.match(command.description, /当前选中会话/);
    assert.match(command.description, /短时授权/);
    assert.match(command.description, /模型上下文/);
    assert.equal(command.params.maxBlocks.default, 80);
    assert.equal(command.params.maxChars.default, 8000);
    const recent = declaration.commands['wechat_visible_reader.read_conversation_recent'];
    assert.match(recent.description, /短暂前置/);
    assert.match(recent.description, /可能被标记已读/);
    assert.match(recent.description, /不会发送消息/);
    assert.equal(recent.params.contact.required, true);
    assert.equal(recent.params.limit.required, true);
    assert.equal(recent.params.acknowledgeUiNavigation.required, true);
    assert.equal(recent.params.acknowledgeUiNavigation.validation, 'handler');
    assert.equal(recent.params.acknowledgeMayMarkRead.required, true);
    assert.equal(recent.params.acknowledgeMayMarkRead.validation, 'handler');
  });

  it('returns authorization_required before calling the native runner', async () => {
    const { node, calls } = makeNode();

    const result = await node.invoke('wechat_visible_reader.read_visible_conversation', {});

    assert.equal(result.success, true);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.error.code, 'authorization_required');
    assert.equal(calls.read.length, 0);
  });

  it('invokes the bounded runner only while armed and returns structured data unchanged', async () => {
    const { node, calls } = makeNode({ armed: true });

    const result = await node.invoke('wechat_visible_reader.read_visible_conversation', {
      maxBlocks: 12,
      maxChars: 500,
    });

    assert.equal(result.success, true);
    assert.deepEqual(result.data, successfulRead());
    assert.deepEqual(calls.read, [{ maxBlocks: 12, maxChars: 500 }]);
  });

  it('forwards trusted owner-message provenance to the named-conversation handler', async () => {
    const { node, calls } = makeNode();
    const invocation = {
      catId: 'codex-sol',
      invocationId: 'invocation-1',
      userId: 'owner-user',
      threadId: 'thread-f265',
      userMessageId: 'message-1',
    };

    const result = await node.invoke(
      'wechat_visible_reader.read_conversation_recent',
      {
        contact: '测试联系人',
        limit: 30,
        acknowledgeUiNavigation: true,
        acknowledgeMayMarkRead: true,
      },
      invocation,
    );

    assert.equal(result.success, true);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.targetHeader, '测试联系人');
    assert.deepEqual(calls.recent, [{ contact: '测试联系人', limit: 30 }]);
  });

  it('returns typed authorization_required through the node before active navigation', async () => {
    const { node, calls } = makeNode();
    const result = await node.invoke(
      'wechat_visible_reader.read_conversation_recent',
      { contact: '测试联系人', limit: 30 },
      {
        catId: 'codex-sol',
        invocationId: 'invocation-1',
        userId: 'owner-user',
        threadId: 'thread-f265',
        userMessageId: 'message-1',
      },
    );

    assert.equal(result.success, true);
    assert.equal(result.data.error.code, 'authorization_required');
    assert.equal(calls.recent.length, 0);
  });

  it('preserves native typed failures as tool data instead of flattening them into strings', async () => {
    const typedFailure = {
      ok: false,
      error: { code: 'layout_not_recognized', userAction: '请调整微信主窗口。' },
    };
    const { node, metrics } = makeNode({ armed: true, readResult: typedFailure });

    const result = await node.invoke('wechat_visible_reader.read_visible_conversation', {});

    assert.equal(result.success, true);
    assert.deepEqual(result.data, typedFailure);
    assert.deepEqual(metrics.snapshot().typedErrors, { layout_not_recognized: 1 });
  });

  it('records successful native reads without retaining OCR text', async () => {
    const privateFragment = 'PRIVATE_WECHAT_BODY';
    const readResult = successfulRead();
    readResult.messageUnits = [
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
    ];
    readResult.totalChars = privateFragment.length;
    const { node, metrics } = makeNode({ armed: true, readResult });

    const result = await node.invoke('wechat_visible_reader.read_visible_conversation', {});

    assert.equal(result.success, true);
    const snapshot = metrics.snapshot();
    assert.equal(snapshot.totalReadAttempts, 1);
    assert.equal(snapshot.totalSuccesses, 1);
    assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(privateFragment));
  });

  it('keeps raw OCR body out of Limb action logs', async () => {
    const privateFragment = 'PRIVATE_WECHAT_BODY';
    const readResult = successfulRead();
    readResult.messageUnits = [
      {
        blockType: 'text',
        isPartial: false,
        text: privateFragment,
        bbox: { x: 0.3, y: 0.4, width: 0.2, height: 0.05 },
        ocrConfidence: 0.99,
        layoutConfidence: 0.96,
        presumedSender: 'other',
        blockHash: 'a'.repeat(64),
      },
    ];
    readResult.totalChars = privateFragment.length;
    const { node } = makeNode({ armed: true, readResult });
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
      'wechat_visible_reader.read_visible_conversation',
      {},
      {
        catId: 'codex-sol',
        invocationId: 'invocation-1',
      },
    );

    assert.equal(result.success, true);
    assert.match(JSON.stringify(result.data), new RegExp(privateFragment));
    const entries = actionLog.getByNode(node.nodeId);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].status, 'completed');
    assert.doesNotMatch(JSON.stringify(entries), new RegExp(privateFragment));
  });

  it('uses probe for health without capture and fails non-macOS closed', async () => {
    const online = makeNode();
    assert.equal(await online.node.healthCheck(), 'online');
    assert.equal(online.calls.probe, 1);
    assert.equal(online.calls.read.length, 0);

    const degraded = makeNode({
      probeResult: { ok: false, error: { code: 'wechat_not_running', userAction: '请先启动微信。' } },
    });
    assert.equal(await degraded.node.healthCheck(), 'degraded');

    const unsupported = makeNode({ platform: 'linux' });
    assert.equal(await unsupported.node.healthCheck(), 'offline');
    assert.equal(unsupported.calls.probe, 0);
    const result = await unsupported.node.invoke('wechat_visible_reader.read_visible_conversation', {});
    assert.equal(result.success, false);
    assert.match(result.error, /macOS/);
  });

  it('retains generic adapter validation for unknown commands', async () => {
    const { node } = makeNode({ armed: true });
    const result = await node.invoke('wechat_visible_reader.unknown', {});

    assert.equal(result.success, false);
    assert.match(result.error, /Unknown command/);
  });
});
