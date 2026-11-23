import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { harness } from './helpers/event-loop-tripwire-harness.js';

async function firstNotification(h) {
  const deadline = performance.now() + 1050;
  while (performance.now() < deadline) {
    for (const file of (await readdir(h.folder)).filter((name) => /^event-loop-tripwire\..*\.ndjson$/.test(name))) {
      const records = (await readFile(`${h.folder}/${file}`, 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
      const record = records.find((entry) => entry.kind === 'event_loop_stall' && entry.phase === 'onset');
      if (record) return record;
    }
    await delay(15);
  }
  assert.fail('no independent onset while the native call is still blocking');
}

test(
  'an uninterruptible child-process call has a durable onset before the main thread returns',
  { timeout: 10000 },
  async (t) => {
    const h = await harness(t);
    h.child.send({ type: 'block', id: 'uninterruptible', ms: 1600, native: 'process' });
    await h.wait((message) => message.type === 'entered');
    const record = await firstNotification(h);
    assert.equal(record.attribution, 'pending');
    assert.deepEqual(record.topFrames, []);
    assert.equal('durationMs' in record, false);
    assert.equal(
      h.messages.some((message) => message.type === 'done'),
      false,
    );
    await h.wait((message) => message.type === 'done');
  },
);

for (const source of [false, true]) {
  test(
    `the actual ${source ? 'source' : 'compiled'} startup composition observes cold work before listen`,
    { timeout: 10000 },
    async (t) => {
      const h = await harness(t, 'startup', source);
      const record = await firstNotification(h);
      assert.equal(record.bootId, 'owned-startup-boot');
      assert.equal('durationMs' in record, false);
      assert.equal(
        h.messages.some((message) => message.type === 'ready'),
        false,
      );
      assert.equal((await h.wait((message) => message.type === 'ready')).ready, true);
    },
  );
}

test(
  'failed API initialization preserves its error and closes the real observer before returning',
  { timeout: 10000 },
  async (t) => {
    const h = await harness(t, 'startup-fails');
    const event = await h.wait((message) => message.type === 'startup-failed');
    assert.equal(event.sameError, true);
    assert.equal(event.profilerReleased, true);
  },
);
