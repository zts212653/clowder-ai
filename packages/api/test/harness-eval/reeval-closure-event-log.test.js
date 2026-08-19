import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const TEST_KEY_PREFIX = 'f266-lifecycle-event-log-test:';

let eventSequence = 0;

function makeEvent(overrides = {}) {
  eventSequence += 1;
  return {
    eventId: `event-${eventSequence}`,
    verdictId: 'verdict-a',
    domainId: 'eval:capability-wakeup',
    type: 'verdict_opened',
    actor: { kind: 'migration', id: 'f266-test' },
    occurredAt: new Date(Date.parse('2026-07-18T00:00:00.000Z') + eventSequence * 1_000).toISOString(),
    reason: 'seed the lifecycle from immutable verdict evidence',
    refs: [{ kind: 'verdict', availability: 'available', value: 'docs/verdict-a.md' }],
    ...overrides,
  };
}

describe('eval verdict lifecycle event log (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let ReevalClosureKeys;
  let RedisReevalClosureEventLog;
  let redis;
  let eventLog;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'EvalVerdictLifecycleEventLog');
    ({ ReevalClosureKeys, RedisReevalClosureEventLog } = await import(
      '../../dist/infrastructure/harness-eval/reeval-closure-event-log.js'
    ));
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: TEST_KEY_PREFIX });
    await redis.ping();
    eventLog = new RedisReevalClosureEventLog(redis);
  });

  after(async () => {
    if (redis) {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    }
  });

  beforeEach(async () => {
    await cleanupClientKeyspace(redis);
  });

  it('atomically appends only at the expected sequence', async () => {
    const opened = makeEvent();
    assert.deepEqual(await eventLog.append(opened, 0), { outcome: 'appended', sequence: 0 });

    const stale = makeEvent({
      eventId: 'stale-ack',
      type: 'owner_acknowledged',
      actor: { kind: 'cat', id: 'codex-sol' },
      reason: 'owner acknowledged the verdict',
      refs: [{ kind: 'message', availability: 'available', value: 'thread:ack' }],
    });
    assert.deepEqual(await eventLog.append(stale, 0), { outcome: 'conflict', actualSequence: 1 });
    assert.equal((await eventLog.read(opened.verdictId)).length, 1);
  });

  it('checks global idempotency before sequence conflict', async () => {
    const opened = makeEvent({ eventId: 'globally-once' });
    await eventLog.append(opened, 0);

    assert.deepEqual(await eventLog.append(opened, 99), { outcome: 'duplicate' });

    const otherVerdict = { ...opened, verdictId: 'verdict-b', domainId: 'eval:capability-tips' };
    assert.deepEqual(await eventLog.append(otherVerdict, 0), { outcome: 'duplicate' });
    assert.deepEqual(await eventLog.read('verdict-b'), []);
  });

  it('lets only one concurrent writer win the same lifecycle edge', async () => {
    const opened = makeEvent();
    await eventLog.append(opened, 0);
    const first = makeEvent({ eventId: 'race-a', type: 'cvo_suppressed', actor: { kind: 'cvo', id: 'you' } });
    const second = makeEvent({ eventId: 'race-b', type: 'cvo_suppressed', actor: { kind: 'cvo', id: 'you' } });

    const results = await Promise.all([eventLog.append(first, 1), eventLog.append(second, 1)]);
    assert.deepEqual(results.map((result) => result.outcome).sort(), ['appended', 'conflict']);
    assert.equal((await eventLog.read(opened.verdictId)).length, 2);
  });

  it('replays through a second instance and lists verdict subjects deterministically', async () => {
    const verdictB = makeEvent({ verdictId: 'verdict-b', domainId: 'eval:capability-tips' });
    const verdictA = makeEvent({ verdictId: 'verdict-a' });
    await eventLog.append(verdictB, 0);
    await eventLog.append(verdictA, 0);

    const secondInstance = new RedisReevalClosureEventLog(redis);
    assert.deepEqual(await secondInstance.read('verdict-a'), [verdictA]);
    assert.deepEqual(await secondInstance.listVerdictIds(), ['verdict-a', 'verdict-b']);
  });

  it('keys schema-v2 cycle events by stable case id while preserving verdict identity in each event', async () => {
    const caseId = `eval-case-v1-${'a'.repeat(64)}`;
    const firstCycle = makeEvent({
      eventId: 'case-cycle-a',
      caseId,
      verdictId: 'verdict-week-a',
      type: 'verdict_cycle_observed',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      cycleCreatedAt: '2026-08-01T00:00:00.000Z',
    });
    const secondCycle = makeEvent({
      eventId: 'case-cycle-b',
      caseId,
      verdictId: 'verdict-week-b',
      type: 'verdict_cycle_observed',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      cycleCreatedAt: '2026-08-08T00:00:00.000Z',
    });

    assert.deepEqual(await eventLog.append(firstCycle, 0), { outcome: 'appended', sequence: 0 });
    assert.deepEqual(await eventLog.append(secondCycle, 1), { outcome: 'appended', sequence: 1 });
    assert.deepEqual(await eventLog.read(caseId), [firstCycle, secondCycle]);
    assert.deepEqual(await eventLog.read(firstCycle.verdictId), []);
    assert.deepEqual(await eventLog.listSubjectIds(), [caseId]);
  });

  it('supports tail reads and never assigns TTL to canonical keys', async () => {
    const opened = makeEvent();
    const acknowledged = makeEvent({
      verdictId: opened.verdictId,
      domainId: opened.domainId,
      type: 'owner_acknowledged',
      actor: { kind: 'cat', id: 'codex-sol' },
    });
    await eventLog.append(opened, 0);
    await eventLog.append(acknowledged, 1);

    assert.deepEqual(await eventLog.read(opened.verdictId, 1), [acknowledged]);
    assert.equal(await redis.ttl(ReevalClosureKeys.eventLog(opened.verdictId)), -1);
    assert.equal(await redis.ttl(ReevalClosureKeys.eventsSeen), -1);
    assert.equal(await redis.ttl(ReevalClosureKeys.verdicts), -1);
  });
});
