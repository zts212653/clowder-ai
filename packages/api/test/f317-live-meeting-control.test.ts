import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMeetingControlFixture as fixture } from './helpers/f317-meeting-control-fixture.js';

test('explicit current owner App request starts F195 and privately attaches the exact capture', async () => {
  const f = fixture();
  const result = await f.service.start(f.principal, {
    requestMessageId: 'request-1',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'start',
  });
  assert.equal(result.kind, 'running');
  assert.deepEqual(f.effects, ['start', 'attach']);
  assert.equal(f.share.current()?.captureThreadId, 'thread-1');
});

test('a stop command during start fences late capture and never admits its late transcript', async () => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const pending = new Promise<void>((r) => {
    finish = r;
  });
  const f = fixture({
    beforeStart: async () => {
      entered();
      await pending;
    },
  });
  const opening = f.service.start(f.principal, {
    requestMessageId: 'request-1',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'start',
  });
  const rejected = assert.rejects(opening, /request_unavailable|request_changed/);
  await started;
  f.setRequest('停止录音');
  const stopping = f.service.stop(f.principal, 'request-2');
  finish();
  await rejected;
  assert.equal((await stopping).kind, 'stopped');
  assert.equal(f.getCapture().running, false);
  assert.equal(f.share.current(), null);
  assert.deepEqual(f.effects, ['start', 'stop']);
});

test('failed stop keeps a retryable target but its share grant and late writes stay revoked', async () => {
  const hooks = { stopFails: true };
  const f = fixture(hooks);
  await f.service.start(f.principal, {
    requestMessageId: 'request-1',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'start',
  });
  f.setRequest('停止录音');
  await assert.rejects(f.service.stop(f.principal, 'request-2'), /sidecar_stop_failed/);
  assert.equal(f.share.current(), null);
  assert.equal((await f.service.status(f.principal)).sharing, false);
  hooks.stopFails = false;
  assert.equal((await f.service.stop(f.principal, 'request-2')).kind, 'stopped');
});

test('Host detach failure cannot prevent F195 stop, and unconfirmed teardown is reported honestly', async () => {
  const hooks = { detachFails: false };
  const f = fixture(hooks);
  await f.service.start(f.principal, {
    requestMessageId: 'request-1',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'start',
  });
  hooks.detachFails = true;
  f.setRequest('停止录音');
  const result = await f.service.stop(f.principal, 'request-2');
  assert.equal(result.kind, 'unconfirmed');
  assert.equal(result.sharing, false);
  assert.equal(f.getCapture().running, false);
  assert.equal(f.share.current(), null);
});

test('a named nonexistent target is rejected even after the admitted capture was stopped', async () => {
  const f = fixture();
  await f.service.start(f.principal, {
    requestMessageId: 'request-1',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'start',
  });
  const target = f.getCapture().meetingId;
  f.setRequest('停止录音');
  await f.service.stop(f.principal, 'request-2', target);
  await assert.rejects(f.service.stop(f.principal, 'request-2', 'not-this-meeting'), /target_mismatch/);
  assert.equal((await f.service.stop(f.principal, 'request-2', target)).kind, 'stopped');
  assert.equal(f.effects.filter((e) => e === 'stop').length, 1);
});

test('stop revokes the exact grant before F195 and rejects a different meeting without effects', async () => {
  const f = fixture();
  await f.service.start(f.principal, {
    requestMessageId: 'request-1',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'start',
  });
  f.setRequest('停止录音');
  await assert.rejects(f.service.stop(f.principal, 'request-2', 'wrong-meeting'), /target_mismatch/);
  assert.deepEqual(f.effects, ['start', 'attach']);
  const target = f.getCapture().meetingId;
  assert.equal((await f.service.stop(f.principal, 'request-2', target)).kind, 'stopped');
  assert.deepEqual(f.effects, ['start', 'attach', 'detach', 'stop']);
});

test('a duplicate start never records twice, including after stop', async () => {
  const f = fixture();
  const input = { requestMessageId: 'request-1', sourceId: 'com.google.Chrome#pid=42', mode: 'start' as const };
  await f.service.start(f.principal, input);
  await f.service.start(f.principal, input);
  assert.equal(f.effects.filter((e) => e === 'start').length, 1);
  f.setRequest('停止录音');
  await f.service.stop(f.principal, 'request-2', f.getCapture().meetingId);
  f.setRequest('开始听 Google Chrome', 'request-1');
  await f.service.start(f.principal, input);
  assert.equal(f.effects.filter((e) => e === 'start').length, 1);
});

for (const text of [
  '开始听这场会议',
  '开始听 Safari',
  '怎么开始听 Google Chrome？',
  '如果开始听 Google Chrome',
  '开始听“Google Chrome”',
  '接入已有转写 Google Chrome',
  '不要开始听 Google Chrome',
]) {
  test(`unclear or different operation cannot start: ${text}`, async () => {
    const f = fixture();
    f.setRequest(text, 'request-1');
    assert.equal(
      (
        await f.service.start(f.principal, {
          requestMessageId: 'request-1',
          sourceId: 'com.google.Chrome#pid=42',
          mode: 'start',
        })
      ).kind,
      'needs_source',
    );
    assert.deepEqual(f.effects, []);
  });
}

test('attach existing capture never starts another recording, and late call changes cannot read it', async () => {
  const f = fixture();
  f.setCapture({
    ...f.getCapture(),
    running: true,
    lifecycle: 'running',
    threadId: 'record-thread',
    meetingId: 'existing',
    startedAt: 99,
    inputs: [
      {
        id: 'existing-app',
        source: 'app',
        label: 'Google Chrome',
        state: 'running',
        appName: 'com.google.Chrome#pid=42',
      },
    ],
  });
  f.setRequest('接入已有转写 Google Chrome', 'request-1');
  assert.equal(
    (
      await f.service.start(f.principal, {
        requestMessageId: 'request-1',
        sourceId: 'com.google.Chrome#pid=42',
        mode: 'attach',
      })
    ).kind,
    'running',
  );
  assert.deepEqual(f.effects, ['attach']);
  f.setScope('other-call');
  await assert.rejects(f.service.status(f.principal), /call_changed/);
});

test('running and ASR ready with silent PCM is accurately reported without claiming speech success', async () => {
  const f = fixture();
  const result = await f.service.start(f.principal, {
    requestMessageId: 'request-1',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'start',
  });
  assert.equal(result.kind, 'running');
  assert.equal(result.asrState, 'ready');
  assert.equal(result.signal?.state, 'silent');
  assert.equal(result.chunks, 0);
  assert.equal('speechVerified' in result, false);
});

test('a record-only request does not silently grant transcript sharing to Live', async () => {
  const f = fixture();
  f.setRequest('开始录音 Chrome', 'request-1');
  const result = await f.service.start(f.principal, {
    requestMessageId: 'request-1',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'start',
  });
  assert.equal(result.kind, 'running');
  assert.equal(result.sharing, false);
  assert.deepEqual(f.effects, ['start']);
  assert.equal(f.share.current(), null);
  f.setRequest('接入已有转写 Chrome');
  const attached = await f.service.start(f.principal, {
    requestMessageId: 'request-2',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'attach',
  });
  assert.equal(attached.sharing, true);
  assert.deepEqual(f.effects, ['start', 'attach']);
});

test('source ownership changed after attach cannot reveal signal data or stop the new owner’s capture', async () => {
  const f = fixture();
  await f.service.start(f.principal, {
    requestMessageId: 'request-1',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'start',
  });
  f.setCaptureOwner('other-owner');
  await assert.rejects(f.service.status(f.principal), /owner_mismatch/);
  f.setRequest('停止录音');
  await assert.rejects(f.service.stop(f.principal, 'request-2'), /owner_mismatch/);
  assert.equal(f.getCapture().running, true);
  assert.equal(f.effects.includes('stop'), false);
  assert.equal(f.share.current(), null);
});

test('call finish drains an explicit stop already in flight without issuing a second controller command', async () => {
  let entered!: () => void, finish!: () => void;
  const seen = new Promise<void>((r) => {
    entered = r;
  });
  const pending = new Promise<void>((r) => {
    finish = r;
  });
  const f = fixture({
    beforeStop: async () => {
      entered();
      await pending;
    },
  });
  await f.service.start(f.principal, {
    requestMessageId: 'request-1',
    sourceId: 'com.google.Chrome#pid=42',
    mode: 'start',
  });
  f.setRequest('停止录音');
  const stopping = f.service.stop(f.principal, 'request-2');
  await seen;
  const closing = f.service.releaseCall('call-1');
  await Promise.resolve();
  finish();
  await Promise.all([stopping, closing]);
  assert.equal(f.effects.filter((e) => e === 'stop').length, 1);
});

test('controls consume the same canonical grant when the owner shared through the existing UI', async () => {
  const f = fixture();
  f.setCapture({
    ...f.getCapture(),
    running: true,
    lifecycle: 'running',
    threadId: 'record-thread',
    meetingId: 'ui-shared',
    startedAt: 100,
    inputs: [{ id: 'primary', source: 'app', label: 'Chrome', state: 'running', appName: 'com.google.Chrome#pid=42' }],
  });
  const preview = await f.share.preview('owner');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') throw new Error('missing fixture preview');
  await f.share.share('owner', preview.intent);
  assert.equal((await f.service.status(f.principal)).sharing, true);
  // UI revocation withdraws only the private feed; explicit owner stop must still stop its known capture.
  await f.share.revoke('owner');
  f.setRequest('停止录音');
  assert.equal((await f.service.stop(f.principal, 'request-2')).kind, 'stopped');
  assert.equal(f.getCapture().running, false);
  assert.equal((await f.service.stop(f.principal)).kind, 'stopped');
  assert.equal(f.effects.filter((effect) => effect === 'stop').length, 1);
});

test('an externally stopped UI share does not block a fresh explicit recording request', async () => {
  const f = fixture();
  f.setCapture({
    ...f.getCapture(),
    running: true,
    lifecycle: 'running',
    threadId: 'record-thread',
    meetingId: 'ui-shared',
    startedAt: 100,
    inputs: [{ id: 'primary', source: 'app', label: 'Chrome', state: 'running', appName: 'com.google.Chrome#pid=42' }],
  });
  const preview = await f.share.preview('owner');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') throw new Error('preview unavailable');
  await f.share.share('owner', preview.intent);
  await f.service.status(f.principal);
  f.setCapture({ ...f.getCapture(), running: false, lifecycle: 'stopped' });
  f.setRequest('开始录音 Google Chrome');
  const next = await f.service.start(f.principal, { sourceId: 'com.google.Chrome#pid=42', mode: 'start' });
  assert.equal(next.kind, 'running');
  assert.equal(next.sharing, false);
  assert.equal(f.effects.filter((effect) => effect === 'start').length, 1);
});
