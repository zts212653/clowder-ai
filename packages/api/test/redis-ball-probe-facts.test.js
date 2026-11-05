import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RedisBallCustodyEventLog } from '../dist/domains/ball-custody/BallCustodyEventLog.js';
import { RedisBallCustodyProjectionStore } from '../dist/domains/ball-custody/BallCustodyProjectionStore.js';
import { createInitialProjection } from '../dist/domains/ball-custody/ball-custody-projection-reducer.js';
import { taskProbeSource } from '../dist/domains/cats/services/stores/ports/TaskProbeSource.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { ownedRedisFixture } from './helpers/owned-redis-fixture.js';

const fixture = ownedRedisFixture('1843-ball-facts');
const subject = 'ball:task:pending',
  meta = `ballcustody:events:meta:${subject}`;
const projectionKey = `ballcustody:projection:${subject}`,
  due = 'ballcustody:recovery:probe:due';
const blocked = (id = subject) => ({ ...createInitialProjection(id, 1000), state: 'blocked', blockedSinceAt: 1000 });

test('malformed recovery facts leave the bounded due queue once, retaining original bytes and healthy neighbors', async () => {
  for (const malformed of [
    '{broken',
    JSON.stringify({
      v: 1,
      subjectKey: subject,
      generation: 1,
      notices: {},
      probe: { scope: 'bad', revision: 1, failures: 0, nextAt: null },
    }),
  ]) {
    const redis = fixture.client(`bad-facts-${randomUUID()}:`),
      store = new RedisBallCustodyProjectionStore(redis);
    await store.save(blocked());
    await store.save(blocked('ball:task:healthy'));
    await store.initializeRecovery();
    await redis.hset(meta, 'probeRecovery', malformed);
    const candidates = await store.listProbeRecoveryCandidates(100, 2000);
    assert.deepEqual(
      candidates.map((candidate) => candidate.subjectKey),
      ['ball:task:healthy'],
    );
    const facts = await store.getRecoveryFacts(subject);
    assert.equal(facts.disposition, 'needs_attention');
    assert.equal(facts.reasonCode, 'invalid_recovery_metadata');
    assert.equal(facts.originalRaw, malformed);
    assert.equal(await redis.zscore(due, subject), null);
    assert.equal(await redis.get(projectionKey), JSON.stringify(blocked()));
    await store.initializeRecovery(true);
    assert.equal(await redis.zscore(due, subject), null, 'census cannot reanimate malformed work');
  }
});

test('a stale derived member with no original projection or metadata is removed without inventing execution truth', async () => {
  const redis = fixture.client(`stale-member-${randomUUID()}:`),
    store = new RedisBallCustodyProjectionStore(redis);
  await store.initializeRecovery();
  await redis.zadd(due, 0, subject);
  assert.deepEqual(await store.listProbeRecoveryCandidates(100, 2000), []);
  assert.equal(await redis.zscore(due, subject), null);
  assert.equal(await store.get(subject), null);
});

test('an invalid derived index cannot partially publish a projection or its original recovery facts', async () => {
  const redis = fixture.client(`atomic-projection-${randomUUID()}:`),
    store = new RedisBallCustodyProjectionStore(redis);
  await store.save(blocked());
  const original = await redis.get(projectionKey),
    facts = await redis.hget(meta, 'probeRecovery');
  await redis.set('ballcustody:recovery:wake-audit:due', 'wrong-type');
  await assert.rejects(
    store.save({ ...blocked(), state: 'resolved', lastEventAt: 2000 }),
    /invalid_ball_recovery_index/,
  );
  assert.equal(await redis.get(projectionKey), original);
  assert.equal(await redis.hget(meta, 'probeRecovery'), facts);
});

test('exact EventLog confirmation requires original content; legacy proof is built only by explicit census', async () => {
  const redis = fixture.client(`exact-event-${randomUUID()}:`),
    log = new RedisBallCustodyEventLog(redis);
  const event = {
    sourceEventId: 'original-wake',
    subjectKey: subject,
    kind: 'ball.wake_sent',
    classification: 'informational',
    at: 1000,
    payload: { ownerCatId: 'codex61-sol', threadId: 'home', blockedSinceAt: 1000 },
  };
  await redis.rpush(`ballcustody:events:log:${subject}`, JSON.stringify(event));
  await redis.sadd('ballcustody:events:seen', event.sourceEventId);
  await redis.sadd('ballcustody:events:subjects', subject);
  assert.equal((await log.appendExact(event)).confirmed, false, 'seen-only cannot confirm a legacy audit');
  await log.initializeExactIndex(subject);
  assert.equal((await new RedisBallCustodyEventLog(redis).appendExact(event)).confirmed, true);
  await assert.rejects(
    log.appendExact({ ...event, payload: { ...event.payload, ownerCatId: 'codex-astra' } }),
    /ball_event_identity_conflict/,
  );
  assert.equal((await log.read(subject)).length, 1);
  const other = { ...event, subjectKey: 'ball:task:other', sourceEventId: 'other-wake' };
  await redis.set(`ballcustody:events:meta:${other.subjectKey}`, 'wrong-type');
  await assert.rejects(log.appendExact(other), /invalid_ball_event_index/);
  assert.equal(await redis.sismember('ballcustody:events:seen', other.sourceEventId), 0);
  assert.equal(await redis.llen(`ballcustody:events:log:${other.subjectKey}`), 0);
});

test('Redis probe completion checks the captured owner, thread and probe while preserving unrelated edits', async () => {
  const redis = fixture.client(`task-probe-cas-${randomUUID()}:`),
    tasks = new RedisTaskStore(redis);
  for (const change of [
    { probe: { kind: 'redis_exists', key: 'new-condition' } },
    { ownerCatId: 'codex-astra' },
    { threadId: 'new-home' },
  ]) {
    const task = await tasks.create({
      threadId: 'home',
      title: 'probe',
      userId: 'user',
      createdBy: 'codex61-sol',
      ownerCatId: 'codex61-sol',
      status: 'blocked',
      resolveMode: 'completes',
      probe: { kind: 'redis_exists', key: 'condition' },
    });
    await tasks.update(task.id, { status: 'blocked' });
    const original = taskProbeSource(await tasks.get(task.id));
    await tasks.update(task.id, change);
    assert.equal(await tasks.completeProbeIfCurrent(task.id, original), null);
    assert.equal((await tasks.get(task.id)).status, 'blocked');
  }
  const task = await tasks.create({
    threadId: 'home',
    title: 'probe',
    userId: 'user',
    createdBy: 'codex61-sol',
    ownerCatId: 'codex61-sol',
    status: 'blocked',
    resolveMode: 'completes',
    probe: { kind: 'redis_exists', key: 'condition' },
  });
  await tasks.update(task.id, { status: 'blocked' });
  const source = taskProbeSource(await tasks.get(task.id));
  await tasks.update(task.id, { why: 'new diagnostic only' });
  assert.equal((await tasks.completeProbeIfCurrent(task.id, source)).why, 'new diagnostic only');
  assert.equal((await tasks.get(task.id)).status, 'done');
  assert.equal(await tasks.completeProbeIfCurrent(task.id, source), null, 'terminal completion is immutable');
});
