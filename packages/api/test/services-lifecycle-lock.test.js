import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createServiceLifecycleLock, holdStartupGrace } from '../dist/routes/services-lifecycle-lock.js';

function createReply() {
  return {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
  };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('service lifecycle lock', () => {
  it('holds detached startup guard for every lifecycle action', async () => {
    mock.timers.enable({ apis: ['setTimeout'], now: 0 });
    try {
      const { withLock } = createServiceLifecycleLock();

      const first = await withLock('whisper-stt', createReply(), async () => holdStartupGrace({ ok: true }, 60_000), {
        action: 'start',
      });
      assert.deepEqual(first, { ok: true });

      mock.timers.tick(30_000);
      await flushMicrotasks();

      const secondReply = createReply();
      const second = await withLock('whisper-stt', secondReply, async () => ({ ok: true }), { action: 'start' });
      assert.equal(secondReply.statusCode, 409);
      assert.match(second.error, /already in progress/);

      let stopRan = false;
      const stopReply = createReply();
      const stop = await withLock(
        'whisper-stt',
        stopReply,
        async () => {
          stopRan = true;
          return { ok: true };
        },
        { action: 'stop' },
      );
      assert.equal(stopReply.statusCode, 409);
      assert.match(stop.error, /already in progress/);
      assert.equal(stopRan, false);

      mock.timers.tick(30_000);
      await flushMicrotasks();

      const thirdReply = createReply();
      const third = await withLock('whisper-stt', thirdReply, async () => ({ ok: true }), { action: 'start' });
      assert.equal(thirdReply.statusCode, 200);
      assert.deepEqual(third, { ok: true });
    } finally {
      mock.timers.reset();
    }
  });
});
