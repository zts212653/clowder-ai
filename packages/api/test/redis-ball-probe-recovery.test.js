import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RedisBallCustodyEventLog } from '../dist/domains/ball-custody/BallCustodyEventLog.js';
import { BallCustodyProbeScheduler } from '../dist/domains/ball-custody/BallCustodyProbeScheduler.js';
import { RedisBallCustodyProjectionStore } from '../dist/domains/ball-custody/BallCustodyProjectionStore.js';
import { BallCustodyProjector } from '../dist/domains/ball-custody/BallCustodyProjector.js';
import { createInitialProjection } from '../dist/domains/ball-custody/ball-custody-projection-reducer.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { auditRecoveryRedis } from './helpers/recovery-store-audit.js';

const fixture = ownedRedisFixture('1843-ball-probe');
async function tickAfterCensus(scheduler) {
  for (let round = 0; round < 100; round++) {
    const result = await scheduler.tick();
    if (!result.initializing) return result;
    assert.equal(result.failed, 0, 'bounded first discovery is not a business failure');
    assert.equal(
      result.checked + result.woken + result.completed + result.idleMarked,
      0,
      'business work stays unentered until the original census is ready',
    );
  }
  assert.fail('the cold owner must finish its resumable census');
}
function dependencies(store, now, evaluate = async () => ({ satisfied: false })) {
  return {
    projectionStore: store,
    now,
    taskStore: {
      get: async (id) => ({
        id,
        status: 'blocked',
        probe: { kind: 'redis_exists', key: 'read-only-condition' },
        resolveMode: 'bounces_back',
        ownerCatId: 'codex61-sol',
        threadId: 'home',
        userId: 'user',
      }),
    },
    probeEvaluator: { evaluate },
    ballCustody: { record: async () => assert.fail('normal waiting must not emit events') },
    wakeSender: { send: async () => assert.fail('normal waiting must not wake') },
  };
}

test('fixed blocked probe work reads constant Redis data with tenfold settled projection history', async () => {
  for (const history of [100, 1000]) {
    const redis = fixture.client(`probe-history-${history}-${randomUUID()}:`);
    const store = new RedisBallCustodyProjectionStore(redis);
    for (let n = 0; n < history; n++)
      await store.save({ ...createInitialProjection(`ball:task:history-${n}`, 1), state: 'resolved' });
    await store.save({
      ...createInitialProjection('ball:task:pending', 1),
      state: 'blocked',
      blockedSinceAt: 1,
      resolveMode: 'bounces_back',
    });
    await store.initializeRecovery?.();
    const audit = await auditRecoveryRedis(redis);
    try {
      assert.equal((await new BallCustodyProbeScheduler(dependencies(store, () => 1000)).tick()).checked, 1);
      await audit.flush();
      audit.assertIndexed();
      assert.ok(audit.reads.length < 35, 'periodic reads must not enumerate settled projection history');
      assert.equal(audit.reads.filter((read) => read.command === 'smembers').length, 0);
    } finally {
      audit.stop();
    }
  }
});

test('real EventLog projection rebuild cannot revive an exhausted probe recovery budget', async () => {
  const redis = fixture.client(`probe-rebuild-${randomUUID()}:`);
  const store = new RedisBallCustodyProjectionStore(redis),
    log = new RedisBallCustodyEventLog(redis);
  const projector = new BallCustodyProjector(log, store),
    subject = 'ball:task:pending';
  for (const event of [
    { kind: 'ball.handed', at: 1000, payload: { toCatId: 'codex61-sol' } },
    { kind: 'task.blocked', at: 1001, payload: { resolveMode: 'bounces_back' } },
  ]) {
    const complete = {
      ...event,
      subjectKey: subject,
      sourceEventId: `${event.kind}:${event.at}`,
      classification: 'state-changing',
    };
    await log.append(complete);
    await projector.apply(complete);
  }
  let clock = 2000,
    probes = 0;
  const scheduler = new BallCustodyProbeScheduler(
    dependencies(
      store,
      () => clock,
      async () => {
        probes++;
        throw new Error('original probe observation failed');
      },
    ),
  );
  for (let n = 0; n < 8; n++) {
    await scheduler.tick();
    clock += 60_001;
  }
  assert.equal(probes, 5);
  assert.equal((await store.get(subject)).state, 'blocked');
  assert.equal((await store.getRecoveryFacts(subject)).probe.disposition, 'needs_attention');
  await projector.rebuild(subject);
  await store.initializeRecovery(true);
  await new BallCustodyProbeScheduler(
    dependencies(
      new RedisBallCustodyProjectionStore(redis),
      () => clock,
      async () => assert.fail('rebuild cannot restart the exhausted business probe'),
    ),
  ).tick();
  assert.equal((await store.getRecoveryFacts(subject)).probe.failures, 5);
  assert.equal((await store.get(subject)).state, 'blocked');
  assert.equal((await log.read(subject)).length, 2, 'rebuild does not add wakes or business events');
});

test('cold recovery repairs the original wake event after append-before-ack failure without sending another wake', async () => {
  const redis = fixture.client(`probe-wake-receipt-${randomUUID()}:`);
  const store = new RedisBallCustodyProjectionStore(redis),
    log = new RedisBallCustodyEventLog(redis);
  const projector = new BallCustodyProjector(log, store),
    subject = 'ball:task:pending';
  for (const event of [
    { kind: 'ball.handed', at: 1000, payload: { toCatId: 'codex61-sol' } },
    { kind: 'task.blocked', at: 1001, payload: { resolveMode: 'bounces_back' } },
  ]) {
    const complete = {
      ...event,
      subjectKey: subject,
      sourceEventId: `${event.kind}:${event.at}`,
      classification: 'state-changing',
    };
    await log.append(complete);
    await projector.apply(complete);
  }
  let sends = 0;
  const first = dependencies(
    store,
    () => 2000,
    async () => ({ satisfied: true }),
  );
  first.wakeSender = {
    send: async () => {
      sends++;
      return { kind: 'admitted', messageId: 'exact-original-wake', outcome: 'enqueued' };
    },
  };
  first.ballCustody = {
    record: async (event) => {
      await log.append(event);
      throw new Error('crash after event commit');
    },
    recordConfirmed: async (event) => {
      await log.appendExact(event);
      throw new Error('crash after event commit');
    },
  };
  assert.equal((await tickAfterCensus(new BallCustodyProbeScheduler(first))).woken, 1);
  assert.equal((await store.get(subject)).lastWakeAt, null);
  const cold = dependencies(
    new RedisBallCustodyProjectionStore(redis),
    () => 62_001,
    async () => assert.fail('the admitted wake is repaired from its original receipt, not probed again'),
  );
  cold.wakeSender = { send: async () => assert.fail('cannot resend after cold start') };
  cold.ballCustody = {
    record: async (event) => {
      if ((await log.append(event)).appended) await projector.apply(event);
    },
    recordConfirmed: async (event) => {
      const result = await log.appendExact(event);
      if (result.appended) await projector.apply(event);
      return result.confirmed;
    },
  };
  await new BallCustodyProbeScheduler(cold).tick();
  assert.equal(sends, 1);
  assert.equal((await log.read(subject)).length, 3, 'same exact wake event is deduplicated');
  assert.equal((await store.getRecoveryFacts(subject)).wakeReceipt.messageId, 'exact-original-wake');
  await projector.rebuild(subject);
  await store.initializeRecovery(true);
  assert.equal((await store.get(subject)).lastWakeAt, 2000);
  assert.equal((await store.get(subject)).state, 'blocked', 'producer settlement does not complete the Task');
  await new BallCustodyProbeScheduler(cold).tick();
  assert.equal((await log.read(subject)).length, 3);
});

test('idle-long remains a separate due duty for active/parked/void projections', async () => {
  for (const state of ['active', 'parked', 'void']) {
    const redis = fixture.client(`probe-idle-${state}-${randomUUID()}:`);
    const store = new RedisBallCustodyProjectionStore(redis);
    await store.save({ ...createInitialProjection('ball:task:pending', 1000), state });
    const deps = dependencies(
      store,
      () => 62_000,
      async () => assert.fail('idle work cannot run a business probe'),
    );
    deps.idleLongMs = 60_000;
    const events = [];
    deps.ballCustody = {
      record: async (event) => events.push(event),
      recordConfirmed: async (event) => {
        events.push(event);
        return true;
      },
    };
    const result = await tickAfterCensus(new BallCustodyProbeScheduler(deps));
    assert.equal(result.idleMarked, 1);
    assert.equal(events[0].kind, 'task.idle_long');
    assert.equal(
      (await new BallCustodyProbeScheduler(deps).tick()).idleMarked,
      0,
      'one source can finish its idle duty once',
    );
  }
});

test('an older unconfirmed wake event survives a new blocked episode with its original owner and timestamp', async () => {
  const redis = fixture.client(`probe-cross-episode-${randomUUID()}:`);
  const store = new RedisBallCustodyProjectionStore(redis),
    log = new RedisBallCustodyEventLog(redis);
  const projector = new BallCustodyProjector(log, store),
    subject = 'ball:task:pending';
  async function apply(kind, at, payload) {
    const event = {
      kind,
      at,
      payload,
      subjectKey: subject,
      sourceEventId: `${kind}:${at}`,
      classification: 'state-changing',
    };
    await log.append(event);
    await projector.apply(event);
  }
  await apply('ball.handed', 1000, { toCatId: 'codex61-sol' });
  await apply('task.blocked', 1001, { resolveMode: 'bounces_back' });
  const first = dependencies(
    store,
    () => 2000,
    async () => ({ satisfied: true }),
  );
  first.wakeSender = {
    send: async () => ({ kind: 'admitted', messageId: 'original-owner-envelope', outcome: 'enqueued' }),
  };
  first.ballCustody = {
    record: async () => {
      throw new Error('event log unavailable');
    },
    recordConfirmed: async () => {
      throw new Error('event log unavailable');
    },
  };
  await tickAfterCensus(new BallCustodyProbeScheduler(first));
  await apply('task.unblocked', 3000, {});
  await apply('task.blocked', 4000, { resolveMode: 'bounces_back' });
  const cold = dependencies(new RedisBallCustodyProjectionStore(redis), () => 62_001);
  const getTask = cold.taskStore.get;
  cold.taskStore.get = async (id) => ({ ...(await getTask(id)), ownerCatId: 'codex-astra', threadId: 'new-home' });
  cold.ballCustody = {
    record: async (event) => {
      if ((await log.append(event)).appended) await projector.apply(event);
    },
    recordConfirmed: async (event) => {
      const result = await log.appendExact(event);
      if (result.appended) await projector.apply(event);
      return result.confirmed;
    },
  };
  await new BallCustodyProbeScheduler(cold).tick();
  const events = await log.read(subject),
    wake = events.find((event) => event.kind === 'ball.wake_sent');
  assert.ok(wake, 'new business state cannot erase the original owed audit');
  assert.equal(events.length, 5);
  assert.equal(wake.at, 2000);
  assert.equal(wake.payload.ownerCatId, 'codex61-sol');
  assert.equal(wake.payload.threadId, 'home');
  assert.equal((await store.get(subject)).blockedSinceAt, 4000);
  assert.equal((await store.get(subject)).lastWakeAt, null, 'old wake proof cannot fulfill the new episode');
});
