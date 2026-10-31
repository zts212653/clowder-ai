import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isMeetingStopRequest,
  meetingRequestSource,
  requestSharesTranscript,
} from '../src/domains/concierge/meeting/live-meeting-request.js';

const sources = [{ id: 'com.google.Chrome#pid=42', name: 'Google Chrome' }];

test('polite direct requests to listen to a named App remain actionable', () => {
  for (const text of ['你能帮我开始听 Google Chrome 吗？', 'Could you please start listening to Google Chrome?']) {
    assert.equal(meetingRequestSource(text, 'start', sources)?.id, sources[0].id);
    assert.equal(requestSharesTranscript(text, 'start'), true);
  }
});

test('exact catalog names ending in generic meeting words are preserved before suffix handling', () => {
  const catalog = [{ id: 'com.tencent.meeting#pid=42', name: '腾讯会议' }];
  assert.equal(meetingRequestSource('开始听 腾讯会议', 'start', catalog)?.id, catalog[0].id);
  assert.equal(meetingRequestSource('接入已有转写 腾讯会议', 'attach', catalog)?.id, catalog[0].id);
  assert.equal(meetingRequestSource('开始听 腾讯会议的会议', 'start', catalog)?.id, catalog[0].id);
  const ambiguous = [
    ...catalog,
    { id: 'com.tencent.meeting#pid=43', name: '腾讯会议' },
    { id: 'com.tencent.other', name: '腾讯' },
  ];
  assert.equal(meetingRequestSource('开始听 腾讯会议', 'start', ambiguous), null);
});

test('polite record-only and stop requests preserve their distinct effects', () => {
  const text = 'Can you start recording Google Chrome?';
  assert.equal(meetingRequestSource(text, 'start', sources)?.id, sources[0].id);
  assert.equal(requestSharesTranscript(text, 'start'), false);
  assert.equal(isMeetingStopRequest('能不能停止录音？'), true);
  assert.equal(isMeetingStopRequest('Could you stop recording?'), true);
});

test('instructions, negated or conditional requests, and quoted commands do not authorize media', () => {
  for (const text of [
    'How do I start recording Google Chrome?',
    'Could you not start recording Google Chrome?',
    '如果可以开始听 Google Chrome',
    '“开始听 Google Chrome”',
    '你能帮我开始听 Google Chrome 或 Safari 吗？',
  ]) {
    assert.equal(meetingRequestSource(text, 'start', sources), null, text);
  }
});
