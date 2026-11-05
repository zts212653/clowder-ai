import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { queueEntryId } from '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

async function createLedger(t, kind) {
  if (kind === 'memory') return new InMemoryQueueLedgerStore();
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'PR1398 failure-claim recipient race');
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `test-failure-claim:${randomUUID()}:` });
  t.after(async () => {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  return new RedisQueueLedgerStore(redis);
}

for (const kind of ['memory', 'redis']) {
  for (const change of ['add', 'replace', 'hold']) {
    test(
      `${kind}: failure settlement restores the actual claim after concurrent recipient ${change}`,
      { skip: kind === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false },
      async (t) => {
        const store = await createLedger(t, kind);
        const entry = {
          version: 2,
          id: queueEntryId('race-input'),
          threadId: 'race-thread',
          owner: { kind: 'user', userId: 'owner' },
          kind: 'conversation_input',
          from: { kind: 'user', userId: 'owner' },
          targets: ['gemini'],
          payload: { sourceRecordId: 'race-input', messageId: 'race-input', content: 'original source' },
          execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
          delivery: {},
          status: 'queued',
          enqueuedAt: 100,
          priority: 'normal',
        };
        assert.equal((await store.enqueue([entry])).outcome, 'enqueued');
        const queue = new InvocationQueue(store);
        await queue.hydrateFromLedger();
        const originalClaim = store.claim.bind(store);
        let raceWon = false;
        let updated;
        store.claim = async (...args) => {
          if (!raceWon) {
            raceWon = true;
            if (change === 'hold') {
              const held = await originalClaim(entry.threadId, entry.id, 'owner-hold', 110);
              assert.equal(held.outcome, 'claimed');
              const replacement = structuredClone(held.entries[0]);
              replacement.delivery.routingHeldTargetIds = ['gemini'];
              assert.equal(
                (await store.commit(entry.threadId, entry.id, 'owner-hold', 'queued', 120, replacement)).outcome,
                'updated',
              );
            } else {
              const reconciled = await store.reconcileTargets(
                entry.threadId,
                entry.id,
                ['codex'],
                change === 'replace' ? ['gemini'] : [],
                {},
              );
              assert.equal(reconciled.outcome, 'updated');
            }
            updated = await store.get(entry.threadId, entry.id);
          }
          return originalClaim(...args);
        };
        t.after(() => {
          store.claim = originalClaim;
        });
        const claimed = await queue.claimPreAdmissionFailureAcrossUsersDurable(entry.threadId, entry.id, ['gemini']);
        assert.equal(raceWon, true, 'the mutation happens after local eligibility checks and before the durable claim');
        assert.equal(
          claimed,
          null,
          'a stale failure decision must never escape with a changed durable recipient contract',
        );
        assert.deepEqual(
          await store.get(entry.threadId, entry.id),
          updated,
          'restore preserves the winning change and drops the short claim',
        );
        assert.equal(queue.list(entry.threadId, 'owner')[0].status, 'queued');
        assert.deepEqual(
          queue.list(entry.threadId, 'owner')[0].targets,
          updated.targets,
          'process cache follows the restored durable row',
        );
        const restarted = new InvocationQueue(store);
        await restarted.hydrateFromLedger();
        assert.deepEqual(await restarted.getDurableEntry(entry.threadId, entry.id), updated);
        if (change !== 'hold') {
          const retry = await restarted.claimPreAdmissionFailureAcrossUsersDurable(
            entry.threadId,
            entry.id,
            updated.targets,
          );
          assert.ok(retry, 'a fresh failure decision can still claim the updated recipient set');
          assert.deepEqual(retry.targets, updated.targets);
        }
      },
    );
  }
}
