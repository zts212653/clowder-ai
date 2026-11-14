import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RedisBallCustodyProjectionStore } from '../dist/domains/ball-custody/BallCustodyProjectionStore.js';
import { buildWakeSentEvent } from '../dist/domains/ball-custody/ball-custody-events.js';
import { createInitialProjection } from '../dist/domains/ball-custody/ball-custody-projection-reducer.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';
import { auditRecoveryRedis } from './helpers/recovery-store-audit.js';

const fixture = ownedRedisFixture('1843-ball-audit');
const subject = 'ball:task:pending';
const blocked = (at = 1000) => ({ ...createInitialProjection(subject, at), state: 'blocked', blockedSinceAt: at });
const wake = (at = 2000) =>
  buildWakeSentEvent({ taskId: 'pending', threadId: 'home', ownerCatId: 'codex61-sol', blockedSinceAt: 1000, at });
async function prepare(label) {
  const redis = fixture.client(`${label}-${randomUUID()}:`),
    store = new RedisBallCustodyProjectionStore(redis);
  await store.save(blocked());
  return { redis, store, candidate: (await store.listProbeRecoveryCandidates(1, 2000))[0] };
}

test('concurrent same-envelope receipts preserve one original logical wake event and timestamp', async () => {
  const { store, candidate } = await prepare('duplicate-admission');
  assert.equal(await store.recordWakeReceipt(candidate, { messageId: 'same-envelope', event: wake() }), true);
  assert.equal(await store.recordWakeReceipt(candidate, { messageId: 'same-envelope', event: wake(2001) }), true);
  const audits = await store.listWakeAudits(100, 3000);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].audit.event.at, 2000);
  assert.equal((await store.getRecoveryFacts(subject)).wakeReceipt.at, 2000);
  await store.finishWakeAudit(subject, audits[0].audit, true, 3000);
  await store.save(blocked(4000));
  await store.recordWakeReceipt(candidate, { messageId: 'same-envelope', event: wake(5000) });
  assert.deepEqual(
    await store.listWakeAudits(100, 6000),
    [],
    'an archived admission cannot create a second audit in a new scope',
  );
});

test('a receipt arriving after a new episode preserves old audit debt without settling the new producer', async () => {
  const { store, candidate } = await prepare('late-admission');
  await store.save(blocked(4000));
  await store.recordWakeReceipt(candidate, { messageId: 'old-envelope', event: wake() });
  const [owed] = await store.listWakeAudits(100, 5000);
  assert.ok(owed, 'positive persisted admission must retain its audit even when its original scope has ended');
  assert.equal(owed.audit.scope, candidate.scope);
  const facts = await store.getRecoveryFacts(subject);
  assert.notEqual(facts.probe.scope, candidate.scope);
  assert.equal(facts.probe.disposition, undefined);
  assert.equal(facts.wakeReceipt, undefined, 'old acknowledgement cannot own the current producer');
});

test('audit failures leave automatic recovery after five attempts, retaining exact event for explicit recheck', async () => {
  const { redis, store, candidate } = await prepare('audit-budget');
  await store.recordWakeReceipt(candidate, { messageId: 'persisted-envelope', event: wake() });
  for (let n = 0; n < 5; n++) {
    const [owed] = await store.listWakeAudits(1, 2000 + n * 60_001);
    assert.ok(owed);
    await store.finishWakeAudit(subject, owed.audit, false, 2000 + n * 60_001);
  }
  await store.initializeRecovery(true);
  assert.deepEqual(await new RedisBallCustodyProjectionStore(redis).listWakeAudits(100, 1_000_000), []);
  const facts = await store.getRecoveryFacts(subject),
    original = await store.getWakeAudit(subject, facts.latestWakeAttention);
  assert.equal(original.disposition, 'needs_attention');
  assert.equal(original.failures, 5);
  assert.deepEqual(original.event, wake());
  assert.equal((await store.get(subject)).state, 'blocked');
  assert.equal(await store.recheckWakeAudit(subject, original.key), true);
  const [retry] = await store.listWakeAudits(1, 1_000_000);
  await store.finishWakeAudit(subject, retry.audit, true, 1_000_000);
  assert.deepEqual(await store.listWakeAudits(1, 1_000_000), []);
});

test('a permanent probe recovery error remains on the original task owner and schedules no notice work', async () => {
  const { redis, store, candidate } = await prepare('owner-disposition');
  await store.finishRecovery(candidate, 'permanent_error', 2000, {
    userId: 'user',
    threadId: 'home',
    taskId: 'pending',
  });
  const facts = await store.getRecoveryFacts(subject);
  assert.equal(facts.probe.disposition, 'needs_attention');
  assert.equal(facts.probe.reasonCode, 'ball_recovery_failed');
  assert.deepEqual(facts.notices, {});
  const cold = new RedisBallCustodyProjectionStore(redis);
  await cold.initializeRecovery(true);
  assert.deepEqual(await cold.listRecoveryNotices(1, 1_000_000), []);
  assert.equal((await cold.getRecoveryFacts(subject)).probe.disposition, 'needs_attention');
});

test('tenfold archived audit and notice history does not expand pending metadata or periodic reads', async () => {
  for (const history of [100, 1000]) {
    const { redis, store, candidate } = await prepare(`audit-history-${history}`);
    await store.recordWakeReceipt(candidate, { messageId: 'persisted-envelope', event: wake() });
    const pipeline = redis.pipeline();
    for (let n = 0; n < history; n++)
      pipeline.hset(
        `ballcustody:events:meta:${subject}`,
        `wake:old-${n}`,
        JSON.stringify({ old: n, disposition: 'settled' }),
        `notice:old-${n}`,
        JSON.stringify({ state: 'delivered' }),
      );
    for (const [error] of await pipeline.exec()) assert.equal(error, null);
    await store.initializeRecovery(true);
    const audit = await auditRecoveryRedis(redis);
    try {
      assert.equal((await store.listWakeAudits(100, 3000)).length, 1);
      assert.deepEqual(await store.listRecoveryNotices(100, 3000), []);
      await audit.flush();
      audit.assertIndexed();
      assert.equal(
        audit.reads.some(({ command }) => ['hgetall', 'hscan', 'lrange', 'smembers'].includes(command)),
        false,
      );
      assert.ok(audit.reads.length < 12);
      const facts = await redis.hget(`ballcustody:events:meta:${subject}`, 'probeRecovery');
      assert.ok(facts.length < 1500, 'confirmed history stays outside the hot pending fact');
    } finally {
      audit.stop();
    }
    const [owed] = await store.listWakeAudits(1, 3000);
    await store.finishWakeAudit(subject, owed.audit, true, 3000);
    assert.deepEqual((await store.getRecoveryFacts(subject)).wakeAudits, {});
  }
});
