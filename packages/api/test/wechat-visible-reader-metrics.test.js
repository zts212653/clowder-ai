import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { WeChatVisibleReaderMetrics } from '../dist/plugins/wechat-visible-reader/WeChatVisibleReaderMetrics.js';

function success(text = 'PRIVATE_WECHAT_BODY') {
  return {
    ok: true,
    captureId: 'capture-1',
    capturedAt: '2026-07-18T08:00:00.000Z',
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
        text,
        bbox: { x: 0.4, y: 0.2, width: 0.3, height: 0.05 },
        ocrConfidence: 0.98,
        layoutConfidence: 0.96,
        presumedSender: 'other',
        blockHash: 'a'.repeat(64),
      },
    ],
    totalChars: [...text].length,
    truncated: false,
    warnings: [],
  };
}

function failure(code) {
  return { ok: false, error: { code, userAction: 'safe action' } };
}

describe('WeChatVisibleReaderMetrics', () => {
  it('emits privacy-safe rolling success and typed-error telemetry', () => {
    const metrics = new WeChatVisibleReaderMetrics();
    for (let index = 0; index < 15; index += 1) metrics.record(success());
    for (let index = 0; index < 3; index += 1) metrics.record(failure('layout_not_recognized'));
    for (let index = 0; index < 2; index += 1) metrics.record(failure('ocr_low_confidence'));

    const snapshot = metrics.snapshot();

    assert.deepEqual(snapshot, {
      totalReadAttempts: 20,
      totalSuccesses: 15,
      typedErrors: { layout_not_recognized: 3, ocr_low_confidence: 2 },
      recentWindowSize: 20,
      recentSuccessRate: 0.75,
      layoutPauseRecommended: true,
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_WECHAT_BODY/u);
  });

  it('uses only the latest 20 attempts and pauses only below the 80 percent floor', () => {
    const metrics = new WeChatVisibleReaderMetrics();
    for (let index = 0; index < 10; index += 1) metrics.record(failure('capture_failed'));
    for (let index = 0; index < 16; index += 1) metrics.record(success());
    for (let index = 0; index < 4; index += 1) metrics.record(failure('permission_denied'));

    const snapshot = metrics.snapshot();

    assert.equal(snapshot.totalReadAttempts, 30);
    assert.equal(snapshot.totalSuccesses, 16);
    assert.deepEqual(snapshot.typedErrors, { capture_failed: 10, permission_denied: 4 });
    assert.equal(snapshot.recentWindowSize, 20);
    assert.equal(snapshot.recentSuccessRate, 0.8);
    assert.equal(snapshot.layoutPauseRecommended, false);
  });
});
