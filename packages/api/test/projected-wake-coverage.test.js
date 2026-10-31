import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { RedisQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/RedisQueueLedgerStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import {
  commitFailedResponseAndEnqueueA2ACaller,
  commitRecoveredFailedResponse,
} from '../dist/routes/callback-a2a-trigger.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

for (const backend of ['memory', 'redis']) {
  describe(
    `${backend}: projected wake coverage transaction`,
    { skip: backend === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false },
    () => {
      let redis;
      let store;
      let ledger;
      before(async () => {
        if (backend !== 'redis') return;
        assertRedisIsolationOrThrow(process.env.REDIS_URL, 'projected wake coverage');
        const { createRedisClient } = await import('@cat-cafe/shared/utils');
        redis = createRedisClient({ url: process.env.REDIS_URL });
        await redis.ping();
      });
      beforeEach(async () => {
        if (redis) await cleanupPrefixedRedisKeys(redis, ['msg:*', 'queue:*']);
        store = redis ? new RedisMessageStore(redis, { ttlSeconds: 0 }) : new MessageStore();
        ledger = redis ? new RedisQueueLedgerStore(redis) : new InMemoryQueueLedgerStore();
      });
      after(async () => {
        if (redis) {
          await cleanupPrefixedRedisKeys(redis, ['msg:*', 'queue:*']);
          await redis.quit();
        }
      });

      async function fixture(secondOptions = {}, messageOptions = {}) {
        const queue = new InvocationQueue(ledger, { resolveTargets: async (targets) => targets });
        const make = async (caller, overrides = {}) => {
          const body = `${caller} exact public body`;
          const from = { kind: 'agent', catId: caller };
          return queue.send(
            store,
            {
              userId: 'owner',
              threadId: 'coverage',
              from,
              content: body,
              mentions: ['opus'],
              timestamp: Date.now(),
              ...messageOptions,
            },
            {
              kind: 'message_wake',
              userId: 'owner',
              threadId: 'coverage',
              from,
              content: body,
              targetCats: ['opus'],
              sourceCategory: 'a2a',
              ownerAuthProvenance: 'strict',
              intent: 'execute',
              autoExecute: true,
              messageDisposition: 'next_work',
              ...overrides,
            },
          );
        };
        const first = await make('codex');
        const second = await make('gemini', secondOptions);
        const response = await store.append({
          userId: 'owner',
          threadId: 'coverage',
          from: { kind: 'agent', catId: 'opus' },
          content: '',
          mentions: [],
          timestamp: Date.now(),
          lifecycle: {
            kind: 'response',
            orderKey: 'coverage-run',
            invocationId: 'turn',
            targetId: 'opus',
            inputEntryIds: [],
            inputMessageIds: [],
            status: 'processing',
            startedAt: Date.now(),
          },
        });
        const rows = await ledger.list('coverage');
        const input = {
          threadId: 'coverage',
          userId: 'owner',
          targetId: 'opus',
          invocationId: 'turn',
          responseMessageId: response.id,
          entries: rows.map((entry) => ({ entryId: entry.id, messageId: entry.payload.messageId })),
          at: Date.now(),
        };
        return { queue, first, second, response, rows, input };
      }

      test('one commit binds both independent sources and retires only the covered sibling target', async () => {
        const f = await fixture({ targetCats: ['opus', 'gemini'] });
        const siblingClaim = await ledger.claim('coverage', f.rows[1].id, 'sibling-claim', Date.now(), 'gemini');
        assert.equal(siblingClaim.outcome, 'claimed');
        assert.equal((await f.queue.commitProjectedWakeCoverage(store, f.input)).kind, 'applied');
        const response = await store.getById(f.response.id);
        assert.deepEqual(response.lifecycle.inputMessageIds, [f.first.message.id, f.second.message.id]);
        assert.deepEqual(
          response.lifecycle.inputEntryIds,
          f.input.entries.map((entry) => entry.entryId),
        );
        for (const source of [f.first.message, f.second.message]) {
          const persisted = await store.getById(source.id);
          assert.equal(persisted.content, source.content);
          assert.equal(
            persisted.lifecycle.dispatchRefs.find((ref) => ref.targetId === 'opus').statusMessageId,
            response.id,
          );
        }
        const remaining = await ledger.list('coverage');
        assert.equal(remaining.length, 1);
        assert.deepEqual(remaining[0].targets, ['gemini']);
        assert.equal(remaining[0].claimId, 'sibling-claim');
        assert.deepEqual(remaining[0].claimedTargetIds, ['gemini']);
        assert.equal((await store.commitLifecycleWakeCoverage(f.input, ledger)).kind, 'replayed');
        assert.deepEqual(await ledger.list('coverage'), remaining);
        const restarted = new InvocationQueue(ledger);
        await restarted.hydrateFromLedger(store);
        assert.ok((await restarted.listAllDurable('coverage')).every((entry) => !entry.targets.includes('opus')));
      });

      test('legacy published queued speech becomes delivered without moving its visibility position', async () => {
        const f = await fixture({}, { deliveryStatus: 'queued' });
        const before = await store.getById(f.second.message.id);
        assert.equal(before.deliveryStatus, 'queued');
        assert.equal((await store.commitLifecycleWakeCoverage(f.input, ledger)).kind, 'applied');
        const delivered = await store.getById(f.second.message.id);
        assert.equal(delivered.deliveryStatus, 'delivered');
        assert.equal(delivered.visibilitySeq, before.visibilitySeq);
        assert.equal(delivered.timestamp, before.timestamp);
      });

      test('an owner-bound second source rejects the entire transaction without a partial first adoption', async () => {
        const f = await fixture({
          actionSuccessorFence: {
            leaseId: 'lease-1',
            generation: 1,
            dispatchId: 'dispatch-1',
            terminalPredicateDigest: 'predicate-1',
          },
        });
        const before = await ledger.list('coverage');
        const result = await store.commitLifecycleWakeCoverage(f.input, ledger);
        assert.equal(result.kind, 'conflict');
        assert.equal(result.reason, 'owner_not_bindable');
        assert.deepEqual(await ledger.list('coverage'), before);
        assert.deepEqual((await store.getById(f.response.id)).lifecycle.inputMessageIds, []);
        assert.equal((await store.getById(f.first.message.id)).lifecycle?.dispatchRefs?.length ?? 0, 0);
        assert.deepEqual(
          await f.queue.projectedWakeCandidates(
            'coverage',
            'owner',
            'opus',
            [f.first.message.id, f.second.message.id],
            store,
          ),
          [f.input.entries[0]],
        );
      });

      test('wrong receiver or withdrawn source cannot remove pending work', async () => {
        const f = await fixture();
        const before = await ledger.list('coverage');
        assert.equal(
          (await store.commitLifecycleWakeCoverage({ ...f.input, invocationId: 'other-turn' }, ledger)).kind,
          'conflict',
        );
        assert.equal(
          (await store.commitLifecycleWakeCoverage({ ...f.input, userId: 'other-owner' }, ledger)).kind,
          'conflict',
        );
        assert.deepEqual(await ledger.list('coverage'), before);
        assert.deepEqual((await store.getById(f.response.id)).lifecycle.inputMessageIds, []);
      });

      test('only the exact full projected set is covered; a source outside it remains pending', async () => {
        const f = await fixture();
        assert.equal(
          (await store.commitLifecycleWakeCoverage({ ...f.input, entries: [f.input.entries[0]] }, ledger)).kind,
          'applied',
        );
        const [pending] = await ledger.list('coverage');
        assert.equal(pending.payload.messageId, f.second.message.id);
        assert.deepEqual(pending.targets, ['opus']);
        assert.equal((await store.getById(f.second.message.id)).lifecycle?.dispatchRefs?.length ?? 0, 0);
      });

      if (backend === 'redis')
        test('a terminal winning the Redis CAS race leaves every wake and source ref untouched', async () => {
          const f = await fixture();
          const execute = redis.eval.bind(redis);
          let raced = false;
          redis.eval = async (script, ...args) => {
            if (!raced && script.includes('WAKE_COVERAGE_WRONG_KEY_TYPE')) {
              raced = true;
              assert.equal(
                (
                  await store.commitLifecycleResponseTerminal(f.response.id, {
                    invocationId: 'turn',
                    status: 'canceled',
                    completedAt: Date.now(),
                    content: '',
                    mentions: [],
                  })
                ).kind,
                'applied',
              );
            }
            return execute(script, ...args);
          };
          try {
            assert.equal((await store.commitLifecycleWakeCoverage(f.input, ledger)).kind, 'conflict');
          } finally {
            redis.eval = execute;
          }
          assert.equal(raced, true);
          assert.deepEqual(await ledger.list('coverage'), f.rows);
          for (const source of [f.first.message, f.second.message])
            assert.equal((await store.getById(source.id)).lifecycle?.dispatchRefs?.length ?? 0, 0);
        });

      for (const provenance of ['strict', 'compatibility_fallback', 'unknown'])
        for (const recovery of [false, true]) {
          test(`${recovery ? 'recovered' : 'normal'}/${provenance}: failure returns one exact wake to each covered caller with least authority`, async () => {
            const f = await fixture({ ownerAuthProvenance: provenance });
            assert.equal((await store.commitLifecycleWakeCoverage(f.input, ledger)).kind, 'applied');
            const deps = {
              messageStore: store,
              invocationQueue: f.queue,
              queueProcessor: { requestDrain: async () => {} },
              socketManager: { emitToUser() {}, broadcastAgentMessage() {} },
              log: { info() {}, warn() {}, error() {} },
            };
            const opts = {
              responseMessageId: f.response.id,
              invocationId: 'turn',
              terminal: { status: 'failed', completedAt: Date.now(), reason: 'provider_failed' },
              message: {
                userId: 'owner',
                threadId: 'coverage',
                from: { kind: 'agent', catId: 'opus' },
                content: 'one failed result',
                mentions: [],
                timestamp: Date.now(),
              },
              userId: 'owner',
              threadId: 'coverage',
              reporterCatId: 'opus',
              ownerAuthProvenance: 'strict',
            };
            const run = async () =>
              recovery
                ? commitRecoveredFailedResponse(deps, await store.getById(f.response.id), {
                    invocationId: 'turn',
                    ...opts.terminal,
                    content: opts.message.content,
                    mentions: [],
                  })
                : commitFailedResponseAndEnqueueA2ACaller(deps, opts);
            const failed = await run();
            assert.equal(failed.lifecycle.status, 'failed');
            const [row] = await ledger.list('coverage');
            assert.deepEqual(row.targets, ['codex', 'gemini']);
            assert.equal(
              row.execution.ownerAuthProvenance,
              provenance,
              'the shared carrier cannot promote a covered source',
            );
            assert.equal(row.sourceCategory, 'a2a_failure');
            assert.equal(row.payload.messageId, f.response.id);
            assert.equal((await store.getByThread('coverage')).length, 3, 'no duplicate public failure bubble');
            for (const source of [f.first.message, f.second.message])
              assert.equal((await store.getById(source.id)).lifecycle.dispatchRefs[0].phase, 'settled');
            await run();
            assert.deepEqual(await ledger.list('coverage'), [row], 'failure replay does not duplicate a caller wake');
          });
        }
    },
  );
}
