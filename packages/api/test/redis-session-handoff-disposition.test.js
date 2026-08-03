import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { buildHumanDispositionLedgerReceipt } from '@cat-cafe/shared';
import { RedisSessionHandoffProposalStore } from '../dist/domains/cats/services/stores/redis/RedisSessionHandoffProposalStore.js';
import { CAS_AND_SETTLE_LUA } from '../dist/domains/cats/services/stores/redis/redis-handoff-lua-scripts.js';
import { HandoffKeys } from '../dist/domains/cats/services/stores/redis/session-handoff-keys.js';
import { buildSessionHandoffDispositionLedgerEntry } from '../dist/domains/human-disposition/human-disposition-adapters.js';
import { HumanDispositionKeys } from '../dist/domains/human-disposition/human-disposition-keys.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const KEY_PREFIX = 'cat-cafe-f281-handoff-disposition-test:';

describe('F225 atomic disposition transition', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F225 atomic disposition transition');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    redis = createRedisClient({ url: REDIS_URL, keyPrefix: KEY_PREFIX });
    try {
      await redis.ping();
      connected = true;
      store = new RedisSessionHandoffProposalStore(redis);
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (!connected) return;
    await cleanupClientKeyspace(redis);
    await redis.quit().catch(() => {});
  });

  beforeEach(async () => {
    if (connected) await cleanupClientKeyspace(redis);
  });

  const create = () =>
    store.create({
      sourceThreadId: 'thread_atomic',
      sourceSessionId: 'session_atomic',
      sourceCatId: 'codex-terra',
      sourceMessageId: 'message_atomic',
      userId: 'owner-a',
      note: { done: 'phase b', nextSteps: 'phase c' },
    });

  const rejectInput = (decidedAt = 1_000) => ({
    decidedAt,
    feedback: { reasonCode: 'wrong_lane' },
  });

  async function dump(keys) {
    return Promise.all(
      keys.map(async (key) => {
        const type = await redis.type(key);
        if (type === 'none') return null;
        if (type === 'string') return { type, value: await redis.get(key) };
        if (type === 'hash') {
          const fields = await redis.hgetall(key);
          return { type, value: Object.entries(fields).sort(([left], [right]) => left.localeCompare(right)) };
        }
        if (type === 'zset') return { type, value: await redis.zrange(key, 0, -1, 'WITHSCORES') };
        throw new Error(`unsupported snapshot type: ${type}`);
      }),
    );
  }

  it('converges concurrent exact rejection to one apply plus one replay', async () => {
    const proposal = await create();
    const results = await Promise.all([
      store.markRejected(proposal.proposalId, rejectInput(1_001)),
      store.markRejected(proposal.proposalId, rejectInput(1_002)),
    ]);

    assert.deepEqual(results.map((result) => result.outcome).sort(), ['applied', 'replayed']);
    const settled = await store.get(proposal.proposalId);
    assert.ok([1_001, 1_002].includes(settled.humanDispositionLedgerEntry.episode.decidedAt));
    assert.equal(await redis.hlen(HumanDispositionKeys.receipts('owner-a')), 1);
  });

  it('lets only the canonical approve/reject winner mutate terminal state', async () => {
    const proposal = await create();
    const [claim, rejection] = await Promise.all([
      store.claimForApproval(proposal.proposalId),
      store.markRejected(proposal.proposalId, rejectInput()),
    ]);
    const settled = await store.get(proposal.proposalId);

    if (claim) {
      assert.equal(rejection.outcome, 'not_available');
      assert.equal(settled.status, 'approving');
      assert.equal(settled.humanDispositionLedgerEntry, undefined);
    } else {
      assert.equal(rejection.outcome, 'applied');
      assert.equal(settled.status, 'rejected');
      assert.ok(settled.humanDispositionLedgerEntry);
    }
  });

  it('reports legacy terminal and broken post-Phase-C receipt as distinct fail-closed outcomes', async () => {
    const legacy = await create();
    await redis.hset(HandoffKeys.detail(legacy.proposalId), 'status', 'rejected', 'updatedAt', '900');
    await redis.zrem(HandoffKeys.user('owner-a'), legacy.proposalId);
    await redis.zadd(HandoffKeys.settledUser('owner-a'), 900, legacy.proposalId);
    assert.equal((await store.markRejected(legacy.proposalId, rejectInput())).outcome, 'legacy_unmigrated');
    assert.equal(await redis.exists(HumanDispositionKeys.receipts('owner-a')), 0);

    await cleanupClientKeyspace(redis);
    const current = await create();
    const applied = await store.markRejected(current.proposalId, rejectInput());
    const sourceRef = applied.proposal.humanDispositionLedgerEntry.episode.sourceRef;
    await redis.hdel(HumanDispositionKeys.receipts('owner-a'), sourceRef);
    assert.equal((await store.markRejected(current.proposalId, rejectInput(9_999))).outcome, 'invariant_failure');

    await cleanupClientKeyspace(redis);
    const mismatched = await create();
    await store.markRejected(mismatched.proposalId, rejectInput());
    await redis.hset(HandoffKeys.detail(mismatched.proposalId), 'latestHumanDisposition', '{"reasonCode":"wrong"}');
    assert.equal((await store.markRejected(mismatched.proposalId, rejectInput(9_999))).outcome, 'invariant_failure');
  });

  it('rejects every wrong-type mutation key before producer or ledger bytes change', async (context) => {
    for (const slot of ['detail', 'pending', 'settled', 'receipts', 'ownerIndex', 'subjectIndex']) {
      await context.test(slot, async () => {
        await cleanupClientKeyspace(redis);
        const proposal = await create();
        const keys = {
          detail: HandoffKeys.detail(proposal.proposalId),
          pending: HandoffKeys.user('owner-a'),
          settled: HandoffKeys.settledUser('owner-a'),
          receipts: HumanDispositionKeys.receipts('owner-a'),
          ownerIndex: HumanDispositionKeys.episodes('owner-a'),
          subjectIndex: HumanDispositionKeys.subject('owner-a', 'session_atomic'),
        };
        if (slot === 'detail' || slot === 'pending') await redis.del(keys[slot]);
        await redis.set(keys[slot], `poison-${slot}`);
        const keyList = Object.values(keys);
        const before = await dump(keyList);

        if (slot === 'detail') {
          await assert.rejects(() => store.markRejected(proposal.proposalId, rejectInput()));
          assert.deepEqual(await dump(keyList), before);
          return;
        }
        const result = await store.markRejected(proposal.proposalId, rejectInput());
        assert.equal(result.outcome, 'invariant_failure');
        assert.deepEqual(await dump(keyList), before);
        assert.equal((await store.get(proposal.proposalId)).status, 'pending');
      });
    }
  });

  it('fails malformed receipt state and non-finite time before the first mutation', async () => {
    const proposal = await create();
    const sourceRef = `F225:session-handoff:${proposal.proposalId}:reject`;
    await redis.hset(HumanDispositionKeys.receipts('owner-a'), sourceRef, '{"bad":');
    const keys = [
      HandoffKeys.detail(proposal.proposalId),
      HandoffKeys.user('owner-a'),
      HandoffKeys.settledUser('owner-a'),
      HumanDispositionKeys.receipts('owner-a'),
      HumanDispositionKeys.episodes('owner-a'),
      HumanDispositionKeys.subject('owner-a', 'session_atomic'),
    ];
    const before = await dump(keys);
    assert.equal((await store.markRejected(proposal.proposalId, rejectInput())).outcome, 'invariant_failure');
    assert.deepEqual(await dump(keys), before);

    await assert.rejects(() => store.markRejected(proposal.proposalId, rejectInput(Number.NaN)));
    assert.deepEqual(await dump(keys), before);
  });

  it('preflights malformed entry/receipt JSON inside Lua with zero mutation', async () => {
    const proposal = await create();
    const entry = buildSessionHandoffDispositionLedgerEntry({
      proposal,
      decidedAt: 1_000,
      feedback: { reasonCode: 'wrong_lane' },
    });
    const receipt = buildHumanDispositionLedgerReceipt(entry);
    const keys = [
      HandoffKeys.detail(proposal.proposalId),
      HandoffKeys.user('owner-a'),
      HandoffKeys.settledUser('owner-a'),
      HumanDispositionKeys.receipts('owner-a'),
      HumanDispositionKeys.episodes('owner-a'),
      HumanDispositionKeys.subject('owner-a', receipt.subjectRef),
    ];
    const before = await dump(keys);
    const evaluate = (entryJson, receiptJson) =>
      redis.eval(
        CAS_AND_SETTLE_LUA,
        keys.length,
        ...keys,
        'pending',
        'rejected',
        '1000',
        proposal.proposalId,
        JSON.stringify(entry.episode.feedback),
        entryJson,
        receiptJson,
        receipt.sourceRef,
        receipt.subjectRef,
      );

    assert.equal(await evaluate('{"episode":', JSON.stringify(receipt)), 'INVALID_ENTRY');
    assert.deepEqual(await dump(keys), before);
    assert.equal(await evaluate(JSON.stringify(entry), '{"sourceRef":'), 'INVALID_RECEIPT');
    assert.deepEqual(await dump(keys), before);
  });
});
