import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMeetingControlFixture as fixture } from './helpers/f317-meeting-control-fixture.js';

test('more than 64 distinct requests across completed calls do not disable recording controls', async () => {
  const f = fixture();
  for (let n = 0; n < 66; n++) {
    const callId = `call-${n}`;
    f.setScope(callId);
    f.setRequest('开始录音 Google Chrome', `request-${n}`);
    assert.equal(
      (await f.service.start(f.principal, { sourceId: 'com.google.Chrome#pid=42', mode: 'start' })).kind,
      'running',
    );
    f.setRequest('停止录音', `stop-${n}`);
    await f.service.stop(f.principal);
    await f.service.releaseCall(callId);
  }
  assert.equal(f.effects.filter((effect) => effect === 'start').length, 66);
});

test('a long current call admits fresh requests while the latest repeated input stays idempotent', async () => {
  const f = fixture();
  for (let n = 0; n < 66; n++) {
    f.setRequest('开始录音 Google Chrome', `request-${n}`);
    const input = { sourceId: 'com.google.Chrome#pid=42', mode: 'start' as const };
    assert.equal((await f.service.start(f.principal, input)).kind, 'running');
    await f.service.start(f.principal, input);
    f.setRequest('停止录音', `stop-${n}`);
    await f.service.stop(f.principal);
  }
  f.setRequest('开始录音 Google Chrome', 'request-65');
  await f.service.start(f.principal, { sourceId: 'com.google.Chrome#pid=42', mode: 'start' });
  assert.equal(f.effects.filter((effect) => effect === 'start').length, 66);
});
