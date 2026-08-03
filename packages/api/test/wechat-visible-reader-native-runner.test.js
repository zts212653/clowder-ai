import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createWeChatVisibleReaderNativeRunner,
  MAX_WECHAT_VISIBLE_BLOCKS,
  MAX_WECHAT_VISIBLE_CHARS,
} from '../dist/plugins/wechat-visible-reader/native-runner.js';

const rect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
const nativeSourcePaths = [
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatReaderModels.swift', import.meta.url)),
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatReaderCore.swift', import.meta.url)),
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatLayoutGuard.swift', import.meta.url)),
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatNavigationModels.swift', import.meta.url)),
  fileURLToPath(
    new URL('../src/plugins/wechat-visible-reader/native/WeChatConversationNavigator.swift', import.meta.url),
  ),
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatNavigationFixtures.swift', import.meta.url)),
  fileURLToPath(new URL('../src/plugins/wechat-visible-reader/native/WeChatVisibleReader.swift', import.meta.url)),
];
const accuracyFixturePath = fileURLToPath(
  new URL('../src/plugins/wechat-visible-reader/native/WeChatVisibleReaderAccuracyFixture.swift', import.meta.url),
);
const macOsSelfTestOptions = {
  timeout: 30_000,
  skip: process.platform !== 'darwin' && 'requires macOS xcrun/Swift toolchain',
};
const macOsAccuracyTestOptions = { ...macOsSelfTestOptions, timeout: 60_000 };

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

describe('WeChat visible reader native runner', () => {
  it('probes availability without capture arguments', async () => {
    const calls = [];
    const probeResult = {
      ok: true,
      wechatVersion: '4.1.11',
      profileId: 'wechat-4.1.11-main',
      windowSize: { width: 1158, height: 769 },
    };
    const runner = createWeChatVisibleReaderNativeRunner({
      executablePath: '/safe/WeChatVisibleReader',
      execute: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: JSON.stringify(probeResult) };
      },
    });

    assert.deepEqual(await runner.probe(), probeResult);
    assert.equal(calls[0]?.file, '/safe/WeChatVisibleReader');
    assert.deepEqual(calls[0]?.args, ['--probe']);
  });

  it('fails a malformed probe closed without process output', async () => {
    const privateFragment = 'private-probe-output';
    const runner = createWeChatVisibleReaderNativeRunner({
      execute: async () => ({ stdout: privateFragment }),
    });

    const result = await runner.probe();

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'capture_failed');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateFragment));
  });

  it('uses the compiled executable without a shell and passes bounded read arguments', async () => {
    const calls = [];
    const runner = createWeChatVisibleReaderNativeRunner({
      executablePath: '/safe/WeChatVisibleReader',
      execute: async (file, args, options) => {
        calls.push({ file, args, options });
        return { stdout: JSON.stringify(successfulRead()) };
      },
    });

    const result = await runner.read({ maxBlocks: 12, maxChars: 500 });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [
      {
        file: '/safe/WeChatVisibleReader',
        args: ['--read', '--max-blocks', '12', '--max-chars', '500'],
        options: {
          encoding: 'utf8',
          timeout: 30_000,
          maxBuffer: 512 * 1024,
          windowsHide: true,
        },
      },
    ]);
  });

  it('preserves a valid typed native failure without adding process output', async () => {
    const nativeFailure = {
      ok: false,
      error: { code: 'permission_denied', userAction: '请在系统设置中允许录屏。' },
    };
    const runner = createWeChatVisibleReaderNativeRunner({
      execute: async () => ({ stdout: JSON.stringify(nativeFailure) }),
    });

    assert.deepEqual(await runner.read(), nativeFailure);
  });

  it('fails closed on malformed stdout and does not echo private content', async () => {
    const privateFragment = 'private-wechat-body';
    const runner = createWeChatVisibleReaderNativeRunner({
      execute: async () => ({ stdout: `{not-json:${privateFragment}` }),
    });

    const result = await runner.read();

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'capture_failed');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateFragment));
  });

  it('fails closed on timeout/process errors without echoing stderr', async () => {
    const privateFragment = 'private-stderr-body';
    const runner = createWeChatVisibleReaderNativeRunner({
      execute: async () => {
        throw new Error(`ETIMEDOUT ${privateFragment}`);
      },
    });

    const result = await runner.read();

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'capture_failed');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateFragment));
  });

  it('rejects native results that exceed the requested block cap', async () => {
    const messageUnits = Array.from({ length: 3 }, (_, index) => ({
      ...successfulRead().messageUnits[0],
      blockHash: String(index).padStart(64, 'a'),
    }));
    const runner = createWeChatVisibleReaderNativeRunner({
      execute: async () => ({ stdout: JSON.stringify(successfulRead({ messageUnits })) }),
    });

    const result = await runner.read({ maxBlocks: 2, maxChars: 500 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'capture_failed');
  });

  it('rejects dishonest totalChars and text that exceed the requested char cap', async () => {
    const resultWithOversizedText = successfulRead({
      messageUnits: [{ ...successfulRead().messageUnits[0], text: 'x'.repeat(21) }],
      totalChars: 1,
    });
    const runner = createWeChatVisibleReaderNativeRunner({
      execute: async () => ({ stdout: JSON.stringify(resultWithOversizedText) }),
    });

    const result = await runner.read({ maxBlocks: 5, maxChars: 20 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'capture_failed');
  });

  it('rejects an underreported totalChars value even when both values are below the cap', async () => {
    const runner = createWeChatVisibleReaderNativeRunner({
      execute: async () => ({ stdout: JSON.stringify(successfulRead({ totalChars: 10 })) }),
    });

    const result = await runner.read({ maxBlocks: 5, maxChars: 20 });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'capture_failed');
  });

  it('rejects limits outside the hard contract before launching native code', async () => {
    let calls = 0;
    const runner = createWeChatVisibleReaderNativeRunner({
      execute: async () => {
        calls += 1;
        return { stdout: JSON.stringify(successfulRead()) };
      },
    });

    for (const input of [
      { maxBlocks: 0 },
      { maxBlocks: MAX_WECHAT_VISIBLE_BLOCKS + 1 },
      { maxChars: 0 },
      { maxChars: MAX_WECHAT_VISIBLE_CHARS + 1 },
      { maxBlocks: 1.5 },
    ]) {
      const result = await runner.read(input);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'capture_failed');
    }
    assert.equal(calls, 0);
  });

  it('accepts explicit partial omission and known non-text indicators', async () => {
    const base = successfulRead().messageUnits[0];
    const { blockType: _blockType, isPartial: _isPartial, text: _text, ...unitBase } = base;
    const resultWithAbstention = successfulRead({
      messageUnits: [
        {
          ...unitBase,
          blockType: 'text',
          isPartial: true,
          text: null,
          indicator: 'partial_text_omitted',
        },
        {
          ...unitBase,
          blockType: 'non_textual',
          isPartial: false,
          indicator: 'voice_placeholder',
        },
      ],
      totalChars: 0,
    });
    const runner = createWeChatVisibleReaderNativeRunner({
      execute: async () => ({ stdout: JSON.stringify(resultWithAbstention) }),
    });

    const result = await runner.read();

    assert.equal(result.ok, true);
    assert.equal(result.messageUnits[0].text, null);
    assert.equal(result.messageUnits[1].indicator, 'voice_placeholder');
  });

  it('passes the deterministic crop-before-OCR self-test without writing image files', macOsSelfTestOptions, () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'f265-native-self-test-'));
    const executable = join(tempDirectory, 'wechat-reader-self-test');
    try {
      const compile = spawnSync('/usr/bin/xcrun', ['swiftc', ...nativeSourcePaths, '-o', executable], {
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.equal(compile.status, 0, compile.stderr);
      const processResult = spawnSync(executable, ['--self-test'], {
        cwd: tempDirectory,
        encoding: 'utf8',
        timeout: 10_000,
      });

      assert.equal(processResult.status, 0, processResult.stderr);
      assert.deepEqual(JSON.parse(processResult.stdout), {
        ok: true,
        tests: [
          'crop_before_ocr',
          'header_input_excluded',
          'layout_geometry_guard',
          'layout_marker_guard',
          'partial_abstention',
          'non_text_indicators',
          'page_confidence_fail_closed',
          'in_memory_only',
        ],
      });
      assert.deepEqual(readdirSync(tempDirectory), ['wechat-reader-self-test']);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('passes 100+ Chinese dialogue units at 90% or better without image files', macOsAccuracyTestOptions, () => {
    const tempDirectory = mkdtempSync(join(tmpdir(), 'f265-native-accuracy-'));
    try {
      const processResult = spawnSync('/usr/bin/xcrun', ['swift', accuracyFixturePath], {
        cwd: tempDirectory,
        encoding: 'utf8',
        timeout: 55_000,
      });

      assert.equal(processResult.status, 0, processResult.stderr);
      const result = JSON.parse(processResult.stdout);
      assert.equal(result.ok, true);
      assert.ok(result.unitCount >= 100, `unitCount=${result.unitCount}`);
      assert.ok(result.expectedChars >= 1_000, `expectedChars=${result.expectedChars}`);
      assert.ok(result.accuracy >= 0.9, `accuracy=${result.accuracy}`);
      assert.equal(result.threshold, 0.9);
      assert.deepEqual(result.windowSize, { width: 1158, height: 769 });
      assert.deepEqual(result.bodyRegion, { x: 0.39, y: 0.1, width: 0.59, height: 0.63 });
      assert.equal(result.sidebarCanaryExcluded, true);
      assert.equal(result.headerInputCanariesExcluded, true);
      assert.deepEqual(readdirSync(tempDirectory), []);
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });

  it('keeps forbidden UI-control, database, and image-write APIs out of the native source', () => {
    const source = nativeSourcePaths.map((path) => readFileSync(path, 'utf8')).join('\n');
    const accuracySource = readFileSync(accuracyFixturePath, 'utf8');

    for (const forbidden of [/osascript/iu, /session\.db/iu, /write\s*\(\s*to\s*:/u]) {
      assert.doesNotMatch(`${source}\n${accuracySource}`, forbidden);
    }
    assert.match(source, /SCScreenshotManager\.captureImage/u);
    assert.match(source, /NSApplication\.shared/u);
    assert.match(source, /let cropped = try crop\(image/u);
    assert.match(source, /try recognize\(cropped\)/u);
    assert.match(source, /guard version == "4\.1\.11"/u);
    assert.match(source, /profile\.recognizes\(window: window\.frame\)/u);
    assert.match(source, /PixelLayoutGuard\.matches\(image\)/u);
    assert.match(source, /passesPageConfidence/u);
    assert.match(source, /isPartial\(local\)/u);
    assert.match(source, /y: region\.y \* height/u);
    assert.match(source, /y: body\.y \+ \(1 - Double\(rect\.maxY\)\) \* body\.height/u);
    assert.match(source, /returnedText\?\.unicodeScalars\.count/u);
    assert.match(source, /ocr_only_non_text_may_be_omitted/u);
    assert.match(source, /low_confidence_text_omitted/u);
    for (const indicator of ['image_placeholder', 'voice_placeholder', 'red_packet', 'quote_placeholder']) {
      assert.match(source, new RegExp(indicator));
    }
  });
});
