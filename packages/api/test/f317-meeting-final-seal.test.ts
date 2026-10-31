import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveMeetingAudioError } from '../src/domains/concierge/meeting/live-meeting-audio-error.js';
import type { LiveMeetingAudioPort } from '../src/domains/concierge/meeting/live-meeting-control-contract.js';
import { isMeetingStopRequest } from '../src/domains/concierge/meeting/live-meeting-request.js';
import { createMeetingControlFixture } from './helpers/f317-meeting-control-fixture.js';

test('bare control verbs never authorize stopping meeting media', () => {
  for (const command of ['停止', '结束', '取消', '请停止', '帮我结束', 'stop'])
    assert.equal(isMeetingStopRequest(command), false, command);
  for (const command of ['停止录音', '停止听会', '取消转写', 'stop recording'])
    assert.equal(isMeetingStopRequest(command), true, command);
});

test('unknown start outcome retains its coordinate and reconciles a late accepted capture', async () => {
  let accepted!: Parameters<LiveMeetingAudioPort['start']>[0];
  const f = createMeetingControlFixture({
    beforeStart: async (input) => {
      accepted = input;
      throw new LiveMeetingAudioError(504, 'start', 'reply timed out while sidecar kept working');
    },
  });
  await assert.rejects(f.service.start(f.principal, { sourceId: 'com.google.Chrome#pid=42', mode: 'start' }));
  assert.equal((await f.service.status(f.principal)).kind, 'unconfirmed');
  f.setCapture({
    ...f.getCapture(),
    running: true,
    lifecycle: 'running',
    threadId: accepted.threadId,
    meetingId: accepted.meetingId,
    startedAt: 100,
    inputs: [{ id: 'primary', source: 'app', appName: accepted.source.id, label: 'Chrome', state: 'running' }],
  });
  f.setRequest('停止录音');
  const result = await f.service.stop(f.principal);
  assert.equal(result.kind, 'stopped');
  assert.equal(f.getCapture().running, false);
  assert.equal(f.effects.filter((e) => e === 'stop').length, 1);
});

test('explicit old meeting target cannot cancel the newer opening transaction', async (t) => {
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((r) => {
    release = r;
  });
  const seen = new Promise<void>((r) => {
    entered = r;
  });
  let starts = 0;
  const f = createMeetingControlFixture({
    beforeStart: async () => {
      if (++starts === 2) {
        entered();
        await wait;
      }
    },
  });
  t.after(() => release());
  const first = await f.service.start(f.principal, { sourceId: 'com.google.Chrome#pid=42', mode: 'start' });
  assert.ok('meetingId' in first);
  f.setRequest('停止录音', 'stop-A');
  await f.service.stop(f.principal);
  f.setRequest('开始录音 Google Chrome', 'start-B');
  const opening = f.service.start(f.principal, { sourceId: 'com.google.Chrome#pid=42', mode: 'start' });
  opening.catch(() => undefined);
  await seen;
  f.setRequest('停止录音', 'stop-stale-A');
  const wrongStop = f.service.stop(f.principal, undefined, first.meetingId);
  wrongStop.catch(() => undefined);
  f.setRequest('开始录音 Google Chrome', 'start-B');
  release();
  await assert.rejects(wrongStop, /meeting_stop_target_mismatch/);
  const second = await opening;
  assert.equal(second.kind, 'running');
  assert.equal(f.effects.filter((e) => e === 'stop').length, 1);
});
