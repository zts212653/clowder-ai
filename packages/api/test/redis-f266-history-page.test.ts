import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { type TestContext, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { F266ApprovalAdapter } from '../src/domains/approval-hub/adapters/F266ApprovalAdapter.js';
import {
  EVAL_HISTORY_BYTE_LIMIT,
  EVAL_HISTORY_EVENT_LIMIT,
  EvalRepairHistoryKeys as keys,
} from '../src/infrastructure/harness-eval/eval-repair-history-keys.js';
import {
  advanceEvalRepairHistory,
  evalRepairHistoryPrepared,
  prepareEvalRepairHistory,
} from '../src/infrastructure/harness-eval/eval-repair-history-prepare.js';
import {
  RedisReevalClosureEventLog,
  ReevalClosureKeys,
} from '../src/infrastructure/harness-eval/reeval-closure-event-log.js';
import { EvalLifecycleEventSchema } from '../src/infrastructure/harness-eval/reeval-closure-schema.js';
import { approvalEvents, plainEvent, snapshot } from './helpers/f266-history-fixture.js';
import { cleanupClientKeyspace } from './helpers/redis-test-helpers.js';

async function fixture(t: TestContext) {
  assert.equal(process.env.CAT_CAFE_REDIS_TEST_ISOLATED, '1');
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `f266-history-page:${randomUUID()}:` });
  await redis.ping();
  t.after(async () => {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  const Constructor = process.env.F266_HISTORY_BASELINE
    ? (await import('../src/infrastructure/harness-eval/reeval-closure-event-log.baseline.ts'))
        .RedisReevalClosureEventLog
    : RedisReevalClosureEventLog;
  return { redis, log: new Constructor(redis) };
}
async function prepared(redis: Awaited<ReturnType<typeof fixture>>['redis']) {
  const deadline = performance.now() + 12000;
  while (!(await evalRepairHistoryPrepared(redis)) && performance.now() < deadline) await delay(20);
  assert.equal(
    await evalRepairHistoryPrepared(redis),
    true,
    'bounded preparation must finish after the initiating view closes',
  );
}

test('append atomically marks read-index invalidation; duplicate/conflict never create ghost work', async (t) => {
  const { redis, log } = await fixture(t);
  const first = plainEvent('first');
  assert.deepEqual(await log.append(first, 0), { outcome: 'appended', sequence: 0 });
  assert.deepEqual(await redis.smembers(keys.dirty), ['long-subject']);
  assert.equal(await redis.get(keys.version), 'first');
  await redis.srem(keys.dirty, 'long-subject');
  assert.deepEqual(await log.append(first, 99), { outcome: 'duplicate' });
  assert.equal(await redis.scard(keys.dirty), 0);
  assert.deepEqual(await log.append(plainEvent('conflict'), 0), { outcome: 'conflict', actualSequence: 1 });
  assert.equal(await redis.scard(keys.dirty), 0);
  await redis.set(keys.dirty, 'wrong-type');
  await assert.rejects(log.append(plainEvent('must-not-commit'), 1), /type conflict/);
  assert.equal(await redis.llen(ReevalClosureKeys.eventLog('long-subject')), 1);
  assert.equal(await redis.sismember(ReevalClosureKeys.eventsSeen, 'must-not-commit'), 0);
  assert.equal(await redis.ttl(ReevalClosureKeys.eventLog('long-subject')), -1);
});

test('legacy long subjects prepare in bounded chunks, then >200 pages use original event refs with no full-log read', async (t) => {
  const { redis, log } = await fixture(t);
  const events = Array.from({ length: 150 }, (_, i) => plainEvent(`unrelated:${i}`));
  const ids = Array.from({ length: 211 }, (_, i) => `proposal-${String(i).padStart(4, '0')}`);
  const encoded = [...events, ...ids.flatMap((id) => approvalEvents(id))].map((event) => JSON.stringify(event));
  await redis.rpush(ReevalClosureKeys.eventLog('long-subject'), ...encoded);
  await redis.sadd(ReevalClosureKeys.verdicts, 'long-subject');
  const evalOriginal = redis.eval.bind(redis);
  const chunkSizes: number[] = [];
  const chunkBytes: number[] = [];
  redis.eval = async (...args: Parameters<typeof redis.eval>) => {
    const result = await evalOriginal(...args);
    if (String(args[0]).includes('F266 history sequence regressed') && Array.isArray(result)) {
      chunkSizes.push(result.length - 1);
      chunkBytes.push(result.slice(1).reduce((bytes, event) => bytes + Buffer.byteLength(String(event)), 0));
    }
    return result;
  };
  assert.equal(await prepareEvalRepairHistory(redis), false);
  await prepared(redis);
  assert.ok(chunkSizes.length > 1);
  assert.ok(chunkSizes.every((count) => count <= EVAL_HISTORY_EVENT_LIMIT));
  assert.ok(chunkBytes.every((bytes) => bytes <= EVAL_HISTORY_BYTE_LIMIT));
  assert.deepEqual(
    await redis.lrange(ReevalClosureKeys.eventLog('long-subject'), 0, -1),
    encoded,
    'source bytes stay immutable',
  );
  redis.lrange = async () => {
    throw new Error('whole log read forbidden');
  };
  redis.smembers = async () => {
    throw new Error('whole subject read forbidden');
  };
  assert.ok(log.listApprovalHistoryPage);
  const seen: string[] = [];
  let before;
  for (;;) {
    const page = await log.listApprovalHistoryPage('owner', { limit: 30, before });
    seen.push(...page.records.map((record) => record.proposal.proposalId));
    if (!page.hasMore) break;
    before = page.frontier!;
  }
  assert.deepEqual(seen, [...ids].reverse());
  assert.equal((await log.listApprovalHistoryPage('other', { limit: 30 })).records.length, 0);
  assert.equal(await redis.ttl(ReevalClosureKeys.eventLog('long-subject')), -1);
  await redis.del(keys.owner('owner'));
  await assert.rejects(log.listApprovalHistoryPage('owner', { limit: 30 }), /coverage mismatch/);
});

test('a late preparation batch cannot overwrite a newer append and an explicit read resumes persisted progress', async (t) => {
  const { redis, log } = await fixture(t);
  const events = approvalEvents('one');
  for (const [index, event] of events.entries()) await log.append(event, index);
  const original = redis.eval.bind(redis);
  let raced = false;
  redis.eval = async (...args: Parameters<typeof redis.eval>) => {
    if (!raced && String(args[0]).includes('local edits=cjson.decode')) {
      raced = true;
      await log.append(plainEvent('during-prepare'), events.length);
    }
    return original(...args);
  };
  assert.equal((await advanceEvalRepairHistory(redis)).complete, false);
  assert.equal(await redis.get(keys.proposalSubject('one')), null, 'stale batch commits no refs');
  assert.equal(await prepareEvalRepairHistory(redis), true);
  assert.ok(log.listApprovalHistoryPage);
  const page = await log.listApprovalHistoryPage('owner', { limit: 30 });
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0].proposal.proposalId, 'one');
  assert.equal(await redis.get(keys.subjectSequence('long-subject')), '4');
  assert.equal(await redis.scard(keys.dirty), 0);
});

test('lost append acknowledgement retries globally dedupe before conflict, and racing append remains one-shot', async (t) => {
  const { redis, log } = await fixture(t);
  const original = redis.eval.bind(redis);
  let loseAck = true;
  redis.eval = async (...args: Parameters<typeof redis.eval>) => {
    const value = await original(...args);
    if (loseAck && String(args[0]).includes('local already =')) {
      loseAck = false;
      throw new Error('fixture acknowledgement lost');
    }
    return value;
  };
  const event = plainEvent('ack-lost');
  await assert.rejects(log.append(event, 0), /acknowledgement lost/);
  assert.equal(await redis.llen(ReevalClosureKeys.eventLog('long-subject')), 1);
  assert.deepEqual(await log.append(event, 77), { outcome: 'duplicate' });
  assert.deepEqual(await log.append({ ...event, caseId: 'another-subject' }, 99), { outcome: 'duplicate' });
  assert.equal(await redis.exists(ReevalClosureKeys.eventLog('another-subject')), 0);
  const results = await Promise.all([log.append(plainEvent('race-a'), 1), log.append(plainEvent('race-b'), 1)]);
  assert.deepEqual(results.map((result) => result.outcome).sort(), ['appended', 'conflict']);
  assert.equal(await redis.llen(ReevalClosureKeys.eventLog('long-subject')), 2);
  assert.deepEqual(await redis.smembers(keys.dirty), ['long-subject']);
  assert.equal(await redis.ttl(keys.dirty), -1);
  assert.equal(await redis.ttl(keys.version), -1);
});

test('persisted discovery resumes with a new client, supersession comes from the original projector, and dormant stays dormant', async (t) => {
  const { redis, log } = await fixture(t);
  for (let index = 0; index < 25; index++) {
    const subject = `legacy-subject-${index}`,
      events = approvalEvents(`legacy-${index}`, subject);
    await redis.rpush(ReevalClosureKeys.eventLog(subject), ...events.map((event) => JSON.stringify(event)));
    await redis.sadd(ReevalClosureKeys.verdicts, subject);
  }
  const step = await advanceEvalRepairHistory(redis);
  assert.equal(step.complete, false);
  const oldProgress = JSON.parse((await redis.get(keys.progress))!);
  assert.ok(oldProgress.events > 0);
  const restarted = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: redis.options.keyPrefix });
  await restarted.ping();
  t.after(() => restarted.quit());
  const freshLog = new RedisReevalClosureEventLog(restarted);
  await prepareEvalRepairHistory(restarted);
  await prepared(restarted);
  assert.equal((await freshLog.listApprovalHistoryPage('owner', { limit: 30 })).records.length, 25);
  const { cycleCreatedAt: _unused, ...base } = plainEvent('supersede', 'legacy-subject-0') as ReturnType<
    typeof plainEvent
  > & { cycleCreatedAt: string };
  const event = EvalLifecycleEventSchema.parse({
    ...base,
    type: 'approval_superseded',
    proposalId: 'legacy-0',
    drift: 'target',
    freshCaseActionRef: 'new-action',
    decisionRef: { ownerFeatureId: 'F266', ownerStateRef: 'decision:supersession' },
    requestSnapshot: snapshot,
    occurredAt: '2026-10-27T13:00:00.000Z',
  });
  await log.append(event, 3);
  await prepareEvalRepairHistory(restarted);
  await prepared(restarted);
  const page = await freshLog.listApprovalHistoryPage('owner', { limit: 30 });
  assert.equal(page.records[0].proposal.proposalId, 'legacy-0');
  assert.equal(page.records[0].lifecycle.resolution, 'closed_without_decision');
  assert.equal(page.frontier?.decidedAt, Date.parse('2026-10-27T12:00:00.000Z'));
  const dormant = new F266ApprovalAdapter();
  await assert.rejects(dormant.listSettledPage('owner', { limit: 30 }), {
    statusCode: 503,
    code: 'APPROVAL_HISTORY_UNAVAILABLE',
  });
  assert.equal(await redis.get('eval:friction:v1_active'), null);
});

test('bad derived counts cannot commit a partial batch or claim a complete page; oversized source is explicit', async (t) => {
  const { redis, log } = await fixture(t);
  for (const [index, event] of approvalEvents('bad-count').entries()) await log.append(event, index);
  await redis.hset(keys.ownerCounts, 'owner', 'bad-number');
  await assert.rejects(advanceEvalRepairHistory(redis), /owner count corrupt/);
  assert.equal(await redis.get(keys.proposalSubject('bad-count')), null);
  assert.equal(await redis.exists(keys.proposalEvents('bad-count')), 0);
  assert.equal(await evalRepairHistoryPrepared(redis), false);
  await redis.hdel(keys.ownerCounts, 'owner');
  await prepareEvalRepairHistory(redis);
  await prepared(redis);
  assert.equal((await log.listApprovalHistoryPage('owner', { limit: 30 })).records.length, 1);
  const huge = plainEvent('huge', 'huge-subject');
  huge.reason = 'x'.repeat(EVAL_HISTORY_BYTE_LIMIT + 1);
  await log.append(huge, 0);
  await assert.rejects(advanceEvalRepairHistory(redis), /exceeds byte budget/);
  assert.equal(await evalRepairHistoryPrepared(redis), false);
});

test('restart after an older writer appended canonical events rediscovers tails and new subjects without changing their bytes', async (t) => {
  const { redis, log } = await fixture(t);
  const subject = 'rolling-subject';
  for (const [index, event] of approvalEvents('before-rollback', subject).entries()) await log.append(event, index);
  await prepareEvalRepairHistory(redis);
  await prepared(redis);
  assert.equal((await log.listApprovalHistoryPage('owner', { limit: 30 })).records.length, 1);
  // A legacy producer has only the original event LIST and subject set, with no knowledge of this derived index.
  const additions = [
    [subject, approvalEvents('legacy-tail', subject)],
    ['legacy-new-subject', approvalEvents('legacy-new', 'legacy-new-subject')],
  ] as const;
  for (const [key, events] of additions) {
    await redis.rpush(ReevalClosureKeys.eventLog(key), ...events.map((event) => JSON.stringify(event)));
    await redis.sadd(ReevalClosureKeys.verdicts, key);
  }
  const before = await Promise.all(additions.map(([key]) => redis.lrange(ReevalClosureKeys.eventLog(key), 0, -1)));
  const restarted = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: redis.options.keyPrefix });
  await restarted.ping();
  t.after(() => restarted.quit());
  const freshLog = new RedisReevalClosureEventLog(restarted);
  try {
    const first = await freshLog.listApprovalHistoryPage('owner', { limit: 30 });
    assert.equal(
      first.records.length,
      3,
      'a completed pre-rollback index is not complete coverage of later legacy writes',
    );
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'APPROVAL_HISTORY_PREPARING') throw error;
    await prepared(restarted);
  }
  assert.equal((await freshLog.listApprovalHistoryPage('owner', { limit: 30 })).records.length, 3);
  assert.deepEqual(
    await Promise.all(additions.map(([key]) => redis.lrange(ReevalClosureKeys.eventLog(key), 0, -1))),
    before,
  );
  for (const [key] of additions) assert.equal(await redis.ttl(ReevalClosureKeys.eventLog(key)), -1);
  assert.equal(await redis.get('eval:friction:v1_active'), null);
});
