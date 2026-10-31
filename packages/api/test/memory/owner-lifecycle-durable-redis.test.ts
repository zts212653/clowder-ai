import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, it } from 'node:test';
import { createRedisClient, type RedisClient } from '@cat-cafe/shared/utils';
import { SessionMutex } from '../../src/domains/cats/services/agents/invocation/SessionMutex.js';
import { RedisEventMemoryCorrectionProposalStore } from '../../src/domains/memory/event/RedisEventMemoryCorrectionProposalStore.js';
import { OwnerMemoryActionCoordinator } from '../../src/domains/memory/owner/OwnerMemoryActionCoordinator.js';
import { RedisOwnerMemoryActionReceiptStore } from '../../src/domains/memory/owner/OwnerMemoryActionReceiptStore.js';

let redis: RedisClient;
const prefix = `f321-durable:${randomUUID()}:`;
const revision = `sha256:${'a'.repeat(64)}`;
before(async () => {
  assert.equal(process.env.CAT_CAFE_REDIS_TEST_ISOLATED, '1', 'Use run-isolated-redis-tests.mjs');
  assert.ok(process.env.REDIS_URL);
  const url = new URL(process.env.REDIS_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.ok(![6397, 6398, 6399, 6401].includes(Number(url.port)));
  redis = createRedisClient({ url: url.href, keyPrefix: prefix });
  await redis.ping();
});
after(async () => {
  if (redis) await redis.quit();
});

it('replays a persisted owner action from a new coordinator without mutating twice', async () => {
  const input = {
    ownerUserId: 'owner-a',
    lane: 'event' as const,
    memoryId: 'event-a',
    requestId: randomUUID(),
    command: { action: 'correct', expectedRevision: revision, patch: { summary: '新解释' } },
  };
  let writes = 0;
  const run = async () => {
    writes++;
    return {
      status: 'applied' as const,
      receipt: { action: 'correct' as const, outcome: 'applied' as const, memoryId: 'event-a', revision },
    };
  };
  const first = new OwnerMemoryActionCoordinator({
    store: new RedisOwnerMemoryActionReceiptStore(redis),
    lock: new SessionMutex(),
  });
  const applied = await first.execute(input, { run });
  assert.ok('outcome' in applied);
  assert.equal(applied.outcome, 'applied');
  const reopened = new OwnerMemoryActionCoordinator({
    store: new RedisOwnerMemoryActionReceiptStore(redis),
    lock: new SessionMutex(),
  });
  const replayed = await reopened.execute(input, { run });
  assert.ok('outcome' in replayed);
  assert.equal(replayed.outcome, 'replayed');
  assert.equal(writes, 1);
  assert.deepEqual(
    await reopened.execute({ ...input, command: { ...input.command, patch: { summary: '不同请求' } } }, { run }),
    { error: 'idempotency_conflict' },
  );
});

it('preserves an anchored Event suggestion, deduplication and settled decision across store instances without TTL', async () => {
  const proposalId = 'proposal-a';
  const owner = 'owner-a';
  const requestId = randomUUID();
  const store = new RedisEventMemoryCorrectionProposalStore(redis);
  assert.equal(await store.reserveDedup(owner, requestId, proposalId), proposalId);
  const proposal = await store.create({
    proposalId,
    eventId: 'event-a',
    expectedRevision: revision,
    reason: 'outdated',
    suggestedPatch: { summary: '后来的解释' },
    ownerUserId: owner,
    sourceCatId: 'codex61-sol',
    sourceThreadId: 'suggestion-thread',
    sourceInvocationId: 'invocation-a',
    source: { threadId: 'original-thread', messageId: 'original-message' },
    clientRequestId: requestId,
    approvalOriginRef: { kind: 'message', threadId: 'suggestion-thread', messageId: 'suggestion-message' },
  });
  await store.commitEnvelope(proposalId, {
    canonicalProposalId: proposalId,
    sourceFeatureId: 'F321',
    ownerUserId: owner,
    requesterCatId: 'codex61-sol',
    originRef: proposal.approvalOriginRef,
    approvalCardRef: { threadId: 'suggestion-thread', messageId: 'card-a' },
    createdAt: proposal.createdAt,
  });
  const reopened = new RedisEventMemoryCorrectionProposalStore(redis);
  assert.equal((await reopened.getPublication(proposalId))?.state, 'anchored');
  assert.equal(await reopened.reserveDedup(owner, requestId, 'other-proposal'), proposalId);
  assert.equal((await reopened.countActionableForEvents(owner, ['event-a'])).get('event-a'), 1);
  assert.equal(await reopened.markRejected(proposalId, 'foreign-owner', 'no'), null);
  assert.equal((await reopened.claimForApproval(proposalId, owner))?.status, 'approving');
  assert.equal((await reopened.finalizeApproval(proposalId, owner, revision))?.status, 'approved');
  const settled = new RedisEventMemoryCorrectionProposalStore(redis);
  assert.equal((await settled.listActionableForEvent(owner, 'event-a')).length, 0);
  assert.equal((await settled.listSettled(owner))[0]?.appliedRevision, revision);
  const keys = await redis.keys(`${prefix}*`);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.equal(await redis.ttl(key.slice(prefix.length)), -1, key);
});
