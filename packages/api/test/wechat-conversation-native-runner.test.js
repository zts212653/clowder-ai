import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createWeChatVisibleReaderNativeRunner } from '../dist/plugins/wechat-visible-reader/native-runner.js';

const rect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };

function successfulRead(overrides = {}) {
  return {
    ok: true,
    captureId: 'capture-1',
    capturedAt: '2026-07-17T03:00:00.000Z',
    source: {
      bundleId: 'com.tencent.xinWeChat',
      wechatVersion: '4.1.11',
      windowSize: { width: 1280, height: 900 },
    },
    layout: { profileId: 'wechat-4.1.11-main', confidence: 0.98, bodyRegion: rect },
    messageUnits: [
      {
        blockType: 'text',
        isPartial: false,
        text: 'target text',
        bbox: rect,
        ocrConfidence: 0.99,
        layoutConfidence: 0.98,
        presumedSender: 'other',
        blockHash: 'a'.repeat(64),
      },
    ],
    totalChars: 11,
    truncated: false,
    warnings: [],
    ...overrides,
  };
}

describe('WeChat conversation native runner', () => {
  it('compiles all Swift sources once into a source-digest keyed executable', async () => {
    const calls = [];
    const runner = createWeChatVisibleReaderNativeRunner({
      sourcePaths: ['/safe/Core.swift', '/safe/Navigator.swift', '/safe/CLI.swift'],
      sourceDigest: 'fixture-digest',
      cacheDirectory: '/safe/cache',
      execute: async (file, args, options) => {
        calls.push({ file, args, options });
        if (file === '/usr/bin/xcrun') return { stdout: '' };
        return {
          stdout: JSON.stringify({
            ok: true,
            wechatVersion: '4.1.11',
            profileId: 'wechat-4.1.11-main',
            windowSize: { width: 1158, height: 769 },
          }),
        };
      },
    });

    assert.equal((await runner.probe()).ok, true);
    assert.equal((await runner.probe()).ok, true);
    assert.equal(calls[0].file, '/usr/bin/xcrun');
    assert.deepEqual(calls[0].args, [
      'swiftc',
      '/safe/Core.swift',
      '/safe/Navigator.swift',
      '/safe/CLI.swift',
      '-o',
      '/safe/cache/cat-cafe-wechat-reader-fixture-digest',
    ]);
    assert.equal(calls.filter((call) => call.file === '/usr/bin/xcrun').length, 1);
  });

  it('runs a privacy-safe navigation spike without returning the contact or message body', async () => {
    const calls = [];
    const spikeResult = {
      ok: true,
      targetHeaderMatched: true,
      restore: {
        conversationRestored: true,
        scrollAnchorRestored: true,
        frontApplicationRestored: true,
      },
    };
    const runner = createWeChatVisibleReaderNativeRunner({
      executablePath: '/safe/WeChatVisibleReader',
      execute: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: JSON.stringify(spikeResult) };
      },
    });

    const result = await runner.navigationSpike('测试联系人');

    assert.deepEqual(result, spikeResult);
    assert.deepEqual(calls[0].args, ['--navigation-spike', '--contact', '测试联系人']);
    assert.equal(calls[0].options.timeout, 30_000);
    assert.doesNotMatch(JSON.stringify(result), /测试联系人/u);
  });

  it('runs a bounded named-conversation read and validates restore provenance', async () => {
    const calls = [];
    const recentResult = {
      ...successfulRead({ warnings: ['named_conversation'] }),
      targetHeader: '测试联系人',
      targetHeaderMatched: true,
      restore: {
        conversationRestored: true,
        scrollAnchorRestored: true,
        frontApplicationRestored: true,
      },
    };
    const runner = createWeChatVisibleReaderNativeRunner({
      executablePath: '/safe/WeChatVisibleReader',
      execute: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: JSON.stringify(recentResult) };
      },
    });

    const result = await runner.readConversationRecent({ contact: '测试联系人', limit: 30 });

    assert.deepEqual(result, recentResult);
    assert.deepEqual(calls[0].args, ['--read-conversation-recent', '--contact', '测试联系人', '--limit', '30']);
    assert.equal(calls[0].options.timeout, 60_000);
  });

  it('fails malformed restore reports closed without echoing native output', async () => {
    const privateFragment = 'private-wechat-body';
    const runner = createWeChatVisibleReaderNativeRunner({
      execute: async () => ({
        stdout: JSON.stringify({
          ...successfulRead(),
          targetHeader: '测试联系人',
          targetHeaderMatched: true,
          restore: { conversationRestored: true, scrollAnchorRestored: privateFragment },
        }),
      }),
    });

    const result = await runner.readConversationRecent({ contact: '测试联系人', limit: 30 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'capture_failed');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateFragment));
  });
});
