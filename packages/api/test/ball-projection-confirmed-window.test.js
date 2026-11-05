import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RedisBallCustodyEventLog } from '../dist/domains/ball-custody/BallCustodyEventLog.js';
import { BallCustodyIngest } from '../dist/domains/ball-custody/BallCustodyIngest.js';
import { BallCustodyProbeScheduler } from '../dist/domains/ball-custody/BallCustodyProbeScheduler.js';
import { RedisBallCustodyProjectionStore } from '../dist/domains/ball-custody/BallCustodyProjectionStore.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { createInitialProjection } from '../dist/domains/ball-custody/ball-custody-projection-reducer.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const fixture = ownedRedisFixture('1843-confirmed-projection');
function setup(matches, afterCommit = false) {
  const redis = fixture.client(`${randomUUID()}:`);
  let fail = true;
  const injected = new Proxy(redis, {
    get(target, name) {
      if (name === 'eval')
        return async (...args) => {
          const selected = fail && args[1] === 8 && args[13] === 'write' && matches(JSON.parse(args[14]));
          if (selected) {
            fail = false;
            if (afterCommit) await target.eval(...args);
            throw new Error('projection publication interrupted');
          }
          return target.eval(...args);
        };
      const value = Reflect.get(target, name, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = new RedisBallCustodyProjectionStore(injected),
    events = new RedisBallCustodyEventLog(redis);
  const projector = new BallCustodyProjector(events, store),
    ingest = new BallCustodyIngest(events, projector);
  return { store, events, ingest, failed: () => !fail };
}

test('idle append followed by failed atomic projection remains due and is applied once on the exact retry', async () => {
  const f = setup((projection) => projection.state === 'zombie');
  const subject = 'ball:task:idle-review';
  let now = 40 * 24 * 3600 * 1000;
  await f.store.save({ ...createInitialProjection(subject, 1000), state: 'active' });
  const scheduler = new BallCustodyProbeScheduler({
    projectionStore: f.store,
    taskStore: { get: async () => null },
    ballCustody: f.ingest,
    now: () => now,
    probeEvaluator: { evaluate: async () => assert.fail('idle must not probe') },
    wakeSender: { send: async () => assert.fail('idle must not wake') },
  });
  const first = await scheduler.tick();
  assert.equal(first.failed, 1);
  assert.ok(f.failed());
  assert.equal((await f.store.get(subject)).state, 'active');
  now += 60001;
  assert.equal((await scheduler.tick()).idleMarked, 1);
  const projection = await f.store.get(subject);
  assert.equal(projection.state, 'zombie');
  assert.equal(projection.appliedEventCount, 1);
  now += 60001;
  await scheduler.tick();
  assert.equal((await f.events.read(subject)).length, 1);
  assert.deepEqual(await f.store.get(subject), projection);
});

for (const afterCommit of [false, true])
  test(`wake audit projection proof is atomic and idempotent (response lost=${afterCommit})`, async () => {
    const f = setup((projection) => projection.lastWakeAt === 2000, afterCommit),
      subject = 'ball:task:wake-review';
    await f.store.save({ ...createInitialProjection(subject, 1000), state: 'blocked', blockedSinceAt: 1000 });
    const event = {
      sourceEventId: `wake-${afterCommit}`,
      subjectKey: subject,
      kind: 'ball.wake_sent',
      at: 2000,
      classification: 'informational',
      payload: { blockedSinceAt: 1000 },
    };
    if (afterCommit) assert.equal(await f.ingest.recordConfirmed(event), true);
    else await assert.rejects(f.ingest.recordConfirmed(event), /publication interrupted/);
    assert.ok(f.failed());
    assert.equal(await f.ingest.recordConfirmed(event), true);
    const applied = await f.store.get(subject);
    assert.equal(applied.lastWakeAt, 2000);
    assert.equal(applied.appliedEventCount, 1);
    assert.equal(await f.ingest.recordConfirmed(event), true);
    assert.deepEqual(await f.store.get(subject), applied);
    assert.equal((await f.events.read(subject)).length, 1);
  });

test('a historical exact append without a projection receipt stays unknown until explicit rebuild, without reapplying it', async () => {
  const f = setup(() => false),
    subject = 'ball:task:historical-review';
  const event = {
    sourceEventId: 'historical-event',
    subjectKey: subject,
    kind: 'ball.handed',
    at: 1000,
    classification: 'state-changing',
    payload: { toCatId: 'codex61-sol' },
  };
  await f.ingest.record(event);
  const before = await f.store.get(subject);
  assert.equal(await f.ingest.recordConfirmed(event), false);
  assert.equal(await f.ingest.recordConfirmed(event), false);
  assert.deepEqual(await f.store.get(subject), before);
  await f.ingest.rebuild(subject);
  assert.equal(await f.ingest.recordConfirmed(event), true);
  assert.equal((await f.events.read(subject)).length, 1);
});
