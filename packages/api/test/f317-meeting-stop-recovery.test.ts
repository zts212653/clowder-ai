import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMeetingControlFixture as fixture } from './helpers/f317-meeting-control-fixture.js';

test('Live stop cancels a UI share still awaiting Host attach before it can promote transcript', async () => {
  let release!: () => void, attached!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    attached = resolve;
  });
  const f = fixture({
    beforeAttach: async () => {
      attached();
      await pending;
    },
  });
  f.setCapture({
    ...f.getCapture(),
    running: true,
    lifecycle: 'running',
    threadId: 'record-thread',
    meetingId: 'ui-pending',
    startedAt: 100,
    inputs: [{ id: 'primary', source: 'app', label: 'Chrome', state: 'running', appName: 'com.google.Chrome#pid=42' }],
  });
  const preview = await f.share.preview('owner');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') throw new Error('missing preview');
  const sharing = f.share.share('owner', preview.intent).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await entered;
    const grant = f.share.current();
    assert.ok(grant);
    f.setRequest('停止听会');
    const result = await f.service.stop(f.principal);
    assert.equal(result.kind, 'stopped');
    assert.equal(grant.signal.aborted, true);
    assert.equal(f.share.current(), null);
    assert.equal(f.getCapture().running, false);
  } finally {
    release();
  }
  assert.match(String(await sharing), /meeting_share_not_admitted/);
  assert.equal((await f.share.preview('owner')).kind, 'unavailable');
});

test('call cleanup reconciles an accepted stop after a missing readback, without reusing its released lease', async () => {
  let readable = true;
  const f = fixture({
    observeStatus: (capture) => (readable ? capture : null),
    beforeStop: async () => {
      readable = false;
    },
  });
  await f.service.start(f.principal, { sourceId: 'com.google.Chrome#pid=42', mode: 'start' });
  f.setRequest('停止录音');
  assert.equal((await f.service.stop(f.principal)).kind, 'unconfirmed');
  readable = true;
  await f.service.releaseCall('call-1');
  assert.equal(f.effects.filter((effect) => effect === 'stop').length, 1);
  assert.equal(f.getCapture().running, false);
});

test('stop also cancels a UI share read that has not yet admitted a grant, without guessing its capture', async () => {
  let reading = false,
    release!: () => void,
    entered!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = fixture({
    beforeShareCapture: async () => {
      if (reading) {
        entered();
        await wait;
      }
    },
  });
  f.setCapture({
    ...f.getCapture(),
    running: true,
    lifecycle: 'running',
    threadId: 'record-thread',
    meetingId: 'ui-pending',
    startedAt: 100,
    inputs: [{ id: 'primary', source: 'app', label: 'Chrome', state: 'running', appName: 'com.google.Chrome#pid=42' }],
  });
  const preview = await f.share.preview('owner');
  assert.equal(preview.kind, 'available');
  if (preview.kind !== 'available') throw new Error('missing preview');
  reading = true;
  const sharing = f.share.share('owner', preview.intent).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await read;
    f.setRequest('停止听会');
    assert.equal((await f.service.stop(f.principal)).kind, 'idle');
    assert.equal(f.getCapture().running, true, 'unknown global capture is not selected by stop');
  } finally {
    release();
  }
  assert.match(String(await sharing), /meeting_share_not_admitted/);
  assert.equal(f.effects.includes('attach'), false);
});
