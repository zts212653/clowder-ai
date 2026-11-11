import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.ts';
import { DEFERRED_RECEIPT_FORGET_LUA } from '../src/domains/memory/deferred-person-memory-redis-contract.ts';
import { RedisPersonMemoryStore } from '../src/domains/memory/people/RedisPersonMemoryStore.ts';
import { RedisDeferredPersonMemoryReceiptStore } from '../src/domains/memory/RedisDeferredPersonMemoryReceiptStore.ts';
import { registerCallbackAuthHook } from '../src/routes/callback-auth-prehandler.ts';
import { registerCallbackDeferPersonMemoryRoutes } from '../src/routes/callback-defer-person-memory-routes.ts';
import { personMemoryOwnerReadRoutes } from '../src/routes/person-memory-owner-read.ts';
import { executeOwnerPersonRedaction } from '../src/routes/person-memory-owner-redaction.ts';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';
import { writeOpportunityLineage as lineage } from './memory/person-memory-write-opportunity-fixture.js';

describe(
  'owner deferred terminal invalidation coordination',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  () => {
    let redis, store, people, app, invalidations, purges, failAt;
    const owner = 'owner-deferred-coordination';
    const auth = { origin: 'http://localhost:3003', 'x-csrf-token': 'csrf-coordination' };
    const requestId = `owner_operation_${'1'.repeat(32)}`;
    async function makeApp() {
      const instance = Fastify();
      instance.addHook('onRequest', async (request) => {
        request.sessionUserId = owner;
        request.sessionBindingId = 'coordination-session';
        request.sessionCsrfToken = auth['x-csrf-token'];
      });
      await instance.register(personMemoryOwnerReadRoutes, {
        ownerUserId: owner,
        store: people,
        deferredReceiptStore: store,
        messageStore: {},
        threadStore: {},
        writeOpportunityTerminalLedger: {
          recordInvalidated: async (input) => {
            invalidations.push(input);
            if (failAt === 'ledger') throw new Error('ledger temporarily unavailable');
          },
        },
        writeOpportunityDeliveryStore: {
          purgeLineage: async (who, id) => {
            purges.push({ who, id });
            if (failAt === 'purge') throw new Error('delivery purge temporarily unavailable');
          },
        },
      });
      await instance.ready();
      return instance;
    }
    async function callbackClient(receiptId) {
      const registry = new InvocationRegistry();
      const callback = Fastify();
      registerCallbackAuthHook(callback, registry);
      registerCallbackDeferPersonMemoryRoutes(callback, {
        registry,
        messageStore: {},
        receiptStore: store,
        registryResolver: {},
        writeOpportunityTerminalLedger: {
          recordInvalidated: async (input) => {
            invalidations.push(input);
            if (failAt === 'ledger') throw new Error('ledger temporarily unavailable');
          },
        },
        writeOpportunityDeliveryStore: {
          purgeLineage: async (who, id) => {
            purges.push({ who, id });
            if (failAt === 'purge') throw new Error('purge temporarily unavailable');
          },
        },
      });
      await callback.ready();
      const credentials = await registry.create(
        owner,
        'codex61-sol',
        'thread-current',
        undefined,
        undefined,
        undefined,
        'message-current',
      );
      return {
        post: (action) =>
          callback.inject({
            method: 'POST',
            url: `/api/callbacks/person-memory/deferred/${action}`,
            headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
            payload: { receiptId },
          }),
        close: () => callback.close(),
      };
    }
    async function seed(char = 'a') {
      const receiptId = `deferred_person_${char.repeat(32)}`;
      const source = { kind: 'message', threadId: 'thread-coordinate', messageId: 'message-coordinate' };
      const result = await store.stage({
        receiptId,
        ownerUserId: owner,
        requesterCatId: 'codex61-sol',
        invocationId: 'invocation-coordinate',
        originMessageRef: source,
        subject: 'Sample person',
        normalizedSubject: 'sample person',
        registryBinding: { kind: 'registered_person', ref: 'person_coordinate' },
        sourceCoordinates: [{ kind: 'message', sourceRef: source, resolvedDigest: 'a'.repeat(64) }],
        sourceBundleDigest: 'b'.repeat(64),
        dedupeHash: char.repeat(64),
        ready: true,
        createdAt: 10,
        writeOpportunityLineage: lineage,
        writeOpportunityReceipt: {
          v: 1,
          receiptId,
          ...lineage,
          sourceRefs: [
            {
              artifactId: 'artifact-coordinate',
              sourceRevision: `sha256:${'a'.repeat(64)}`,
              attributionRevision: `sha256:${'b'.repeat(64)}`,
              segmentStart: 0,
              segmentEnd: 1,
            },
          ],
          eligibleAt: 10,
          expiresAt: 100,
          rearmPredicate: 'next_eligible_owner_context_after_defer',
          destinationProposalContract: 'F276.CaptureCandidate.v1',
          state: 'deferred',
        },
      });
      assert.equal(result.outcome, 'created');
      return result.receipt;
    }
    async function readEntry(receiptId) {
      let cursor = '0';
      do {
        const response = await app.inject({ url: `/api/memory/people/deferred?cursor=${cursor}`, headers: auth });
        assert.equal(response.statusCode, 200, response.body);
        const page = response.json();
        const found = page.entries.find((entry) => entry.receiptId === receiptId);
        if (found) return found;
        cursor = page.nextCursor;
      } while (cursor);
      return null;
    }
    const act = (receiptId, action, expectedRevision, id = requestId) =>
      app.inject({
        method: 'POST',
        url: `/api/memory/people/deferred/${receiptId}/actions`,
        headers: auth,
        payload: { action, requestId: id, expectedRevision, confirmed: true },
      });
    async function snapshot() {
      const prefix = redis.options.keyPrefix;
      const keys = (await redis.keys('*')).filter((key) => key.startsWith(prefix)).sort();
      return Object.fromEntries(
        await Promise.all(
          keys.map(async (key) => [key, (await redis.dumpBuffer(key.slice(prefix.length))).toString('hex')]),
        ),
      );
    }
    before(async () => {
      assertRedisIsolationOrThrow(process.env.REDIS_URL, 'owner deferred invalidation coordination');
      redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: 'owner-deferred-coordination-test:' });
      await redis.ping();
      people = new RedisPersonMemoryStore(redis);
      store = new RedisDeferredPersonMemoryReceiptStore(redis);
      app = await makeApp();
    });
    beforeEach(async () => {
      await cleanupClientKeyspace(redis);
      invalidations = [];
      purges = [];
      failAt = undefined;
    });
    after(async () => {
      await app?.close();
      if (redis) {
        await cleanupClientKeyspace(redis);
        await redis.quit();
      }
    });
    for (const action of ['withdraw', 'forget']) {
      it(`${action} CAS refusal has no invalidation and leaves only the clerk's change`, async () => {
        const receipt = await seed();
        const entry = await readEntry(receipt.receiptId);
        const originalEval = redis.eval.bind(redis);
        let raced = false,
          clerkState;
        redis.eval = async (...args) => {
          if (!raced) {
            raced = true;
            const result = await store.claim({
              ownerUserId: owner,
              receiptId: receipt.receiptId,
              claimId: 'claim-race',
              now: 15,
              leaseMs: 100,
              processorCatId: 'codex61-sol',
              processingThreadId: 'thread-clerk',
            });
            assert.equal(result.outcome, 'claimed');
            clerkState = await snapshot();
          }
          return originalEval(...args);
        };
        try {
          const response = await act(receipt.receiptId, action, entry.revision);
          assert.equal(response.statusCode, 409, response.body);
          assert.equal(raced, true);
          assert.deepEqual(invalidations, []);
          assert.deepEqual(purges, []);
          assert.deepEqual(await snapshot(), clerkState);
        } finally {
          redis.eval = originalEval;
        }
      });
      it(`${action} can finish an invalidation failure after refresh and store reconstruction`, async () => {
        const receipt = await seed();
        const initial = await readEntry(receipt.receiptId);
        const originalKeys = Object.keys(await snapshot());
        failAt = 'purge';
        assert.equal((await act(receipt.receiptId, action, initial.revision)).statusCode, 503);
        const pending = await store.get(owner, receipt.receiptId);
        assert.equal(pending.state, 'withdrawn');
        assert.equal(pending.subject, undefined);
        assert.deepEqual(pending.writeOpportunityLineage, lineage);
        assert.equal(await redis.ttl(store.keys.receipt(owner, receipt.receiptId)), -1);
        assert.ok(
          Object.keys(await snapshot()).every((key) => originalKeys.includes(key)),
          'recovery stays in original receipt/index keys',
        );
        if (action === 'forget') {
          assert.equal(pending.ownerForget.requestId, requestId);
          assert.equal(pending.ownerForget.expectedRevision, initial.revision);
          assert.equal((await readEntry(receipt.receiptId)).pendingAction, 'forget');
        }
        await app.close();
        store = new RedisDeferredPersonMemoryReceiptStore(redis);
        app = await makeApp();
        failAt = undefined;
        const response = await act(receipt.receiptId, action, initial.revision);
        assert.equal(response.statusCode, 200, response.body);
        assert.ok(['applied', 'replayed'].includes(response.json().outcome));
        assert.equal(invalidations.at(-1).dedupeLineage, lineage.dedupeLineage);
        assert.deepEqual(purges.at(-1), { who: owner, id: lineage.dedupeLineage });
        if (action === 'forget') assert.equal(await store.get(owner, receipt.receiptId), null);
        else assert.equal((await store.get(owner, receipt.receiptId)).state, 'withdrawn');
      });
    }
    it('refuses withdrawal when a forget plan wins after its snapshot read', async () => {
      const receipt = await seed();
      const entry = await readEntry(receipt.receiptId);
      const originalEval = redis.eval.bind(redis);
      let raced = false;
      let reservedState;
      redis.eval = async (...args) => {
        if (!raced) {
          raced = true;
          const prepared = await store.prepareOwnerForget({
            ownerUserId: owner,
            receiptId: receipt.receiptId,
            requestId: `other_owner_forget_${'2'.repeat(32)}`,
            expectedRevision: entry.revision,
            requestedAt: 15,
            lineageInvalidationAvailable: true,
          });
          assert.equal(prepared.outcome, 'prepared');
          reservedState = await snapshot();
        }
        return originalEval(...args);
      };
      try {
        const response = await act(receipt.receiptId, 'withdraw', entry.revision);
        assert.equal(response.statusCode, 409, response.body);
        assert.deepEqual(invalidations, []);
        assert.deepEqual(purges, []);
        assert.deepEqual(await snapshot(), reservedState);
      } finally {
        redis.eval = originalEval;
      }
    });
    it('lets a fresh owner confirmation join the pending forget but rejects an old revision with another request', async () => {
      const receipt = await seed();
      const initial = await readEntry(receipt.receiptId);
      failAt = 'ledger';
      assert.equal((await act(receipt.receiptId, 'forget', initial.revision)).statusCode, 503);
      const marker = await readEntry(receipt.receiptId);
      assert.equal(marker.pendingAction, 'forget');
      invalidations.length = 0;
      purges.length = 0;
      const nextRequest = `owner_operation_${'2'.repeat(32)}`;
      assert.equal((await act(receipt.receiptId, 'forget', initial.revision, nextRequest)).statusCode, 409);
      assert.deepEqual(invalidations, []);
      assert.deepEqual(purges, []);
      assert.equal((await store.get(owner, receipt.receiptId)).ownerForget.requestId, requestId);
      failAt = undefined;
      assert.equal((await act(receipt.receiptId, 'forget', marker.revision, nextRequest)).statusCode, 200);
      assert.equal(await store.get(owner, receipt.receiptId), null);
    });
    it('keeps a forget plan across a stop after invalidation but before physical deletion', async () => {
      const receipt = await seed();
      const initial = await readEntry(receipt.receiptId);
      const originalForget = store.hardForget.bind(store);
      store.hardForget = async () => {
        throw new Error('process stopped before final deletion');
      };
      assert.equal((await act(receipt.receiptId, 'forget', initial.revision)).statusCode, 503);
      assert.equal((await store.get(owner, receipt.receiptId)).ownerForget.requestId, requestId);
      store.hardForget = originalForget;
      await app.close();
      store = new RedisDeferredPersonMemoryReceiptStore(redis);
      app = await makeApp();
      assert.equal((await act(receipt.receiptId, 'forget', initial.revision)).statusCode, 200);
      assert.equal(await store.get(owner, receipt.receiptId), null);
    });
    it('reports an unknown result rather than a rejection if finalization changes after reservation', async () => {
      const receipt = await seed();
      const initial = await readEntry(receipt.receiptId);
      const originalEval = redis.eval.bind(redis);
      let raced = false;
      redis.eval = async (...args) => {
        if (args[0] === DEFERRED_RECEIPT_FORGET_LUA && !raced) {
          raced = true;
          const pending = await store.get(owner, receipt.receiptId);
          await redis.set(
            store.keys.receipt(owner, receipt.receiptId),
            JSON.stringify({ ...pending, updatedAt: pending.updatedAt + 1 }),
          );
        }
        return originalEval(...args);
      };
      try {
        assert.equal((await act(receipt.receiptId, 'forget', initial.revision)).statusCode, 503);
        assert.equal(raced, true);
        assert.equal((await store.get(owner, receipt.receiptId)).ownerForget.requestId, requestId);
        assert.ok(invalidations.length > 0);
      } finally {
        redis.eval = originalEval;
      }
      assert.equal((await act(receipt.receiptId, 'forget', initial.revision)).statusCode, 200);
    });
    it('replays a lost success response after physical deletion without recreating a recovery marker', async () => {
      const receipt = await seed();
      const initial = await readEntry(receipt.receiptId);
      const originalForget = store.hardForget.bind(store);
      store.hardForget = async (...args) => {
        await originalForget(...args);
        throw new Error('success response lost');
      };
      try {
        assert.equal((await act(receipt.receiptId, 'forget', initial.revision)).statusCode, 503);
      } finally {
        store.hardForget = originalForget;
      }
      assert.equal(await store.get(owner, receipt.receiptId), null);
      const response = await act(receipt.receiptId, 'forget', initial.revision);
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().outcome, 'replayed');
      assert.equal(await store.get(owner, receipt.receiptId), null);
    });
    it('preserves the canonical plan against other terminal constructors and uncredentialed purgers', async () => {
      const receipt = await seed();
      const initial = await readEntry(receipt.receiptId);
      failAt = 'ledger';
      assert.equal((await act(receipt.receiptId, 'forget', initial.revision)).statusCode, 503);
      const pending = await snapshot();
      assert.equal((await store.hardForget(owner, receipt.receiptId)).outcome, 'stale_revision');
      assert.equal((await store.withdraw(owner, receipt.receiptId, 50)).outcome, 'conflict');
      assert.equal((await store.stage({ ...receipt, ready: true })).outcome, 'conflict');
      assert.equal(
        (
          await store.claim({
            ownerUserId: owner,
            receiptId: receipt.receiptId,
            claimId: 'claim-late',
            now: 30,
            leaseMs: 100,
            processorCatId: 'codex61-sol',
            processingThreadId: 'thread-clerk',
          })
        ).outcome,
        'not_available',
      );
      assert.equal(
        (
          await store.disposeClaim({
            ownerUserId: owner,
            receiptId: receipt.receiptId,
            claimId: 'claim-late',
            processorCatId: 'codex61-sol',
            processingThreadId: 'thread-clerk',
            processorInvocationId: 'invocation-late',
            disposition: 'insufficient_evidence',
            now: 30,
          })
        ).outcome,
        'conflict',
      );
      assert.equal(
        (await store.expireClaim({ ownerUserId: owner, receiptId: receipt.receiptId, claimId: 'claim-late', now: 30 }))
          .outcome,
        'conflict',
      );
      assert.deepEqual(await snapshot(), pending);
    });
    it('keeps the old callback request compatible with a pending owner forget plan', async () => {
      const receipt = await seed();
      const initial = await readEntry(receipt.receiptId);
      failAt = 'ledger';
      assert.equal((await act(receipt.receiptId, 'forget', initial.revision)).statusCode, 503);
      failAt = undefined;
      const callback = await callbackClient(receipt.receiptId);
      try {
        invalidations.length = 0;
        purges.length = 0;
        assert.equal((await callback.post('withdraw')).statusCode, 409);
        assert.deepEqual(invalidations, []);
        assert.deepEqual(purges, []);
        const forgotten = await callback.post('forget');
        assert.equal(forgotten.statusCode, 200, forgotten.body);
        assert.equal(forgotten.json().status, 'purged');
        assert.equal(await store.get(owner, receipt.receiptId), null);
      } finally {
        await callback.close();
      }
    });
    for (const action of ['withdraw', 'forget']) {
      it(`legacy callback ${action} shares the same zero-invalidation CAS refusal`, async () => {
        const receipt = await seed();
        const callback = await callbackClient(receipt.receiptId);
        const originalEval = redis.eval.bind(redis);
        let raced = false,
          clerkState;
        redis.eval = async (...args) => {
          if (!raced) {
            raced = true;
            assert.equal(
              (
                await store.claim({
                  ownerUserId: owner,
                  receiptId: receipt.receiptId,
                  claimId: 'claim-callback-race',
                  now: 20,
                  leaseMs: 100,
                  processorCatId: 'codex61-sol',
                  processingThreadId: 'thread-clerk',
                })
              ).outcome,
              'claimed',
            );
            clerkState = await snapshot();
          }
          return originalEval(...args);
        };
        try {
          const response = await callback.post(action);
          assert.equal(response.statusCode, 409, response.body);
          assert.deepEqual(invalidations, []);
          assert.deepEqual(purges, []);
          assert.deepEqual(await snapshot(), clerkState);
        } finally {
          redis.eval = originalEval;
          await callback.close();
        }
      });
    }
    it('retries a legacy receipt-only callback using its original stored forget plan', async () => {
      const receipt = await seed();
      const callback = await callbackClient(receipt.receiptId);
      try {
        failAt = 'purge';
        assert.equal((await callback.post('forget')).statusCode, 503);
        const pending = await store.get(owner, receipt.receiptId);
        assert.match(pending.ownerForget.requestId, /^deferred_callback_[a-f0-9]{64}$/);
        failAt = undefined;
        const result = await callback.post('forget');
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().status, 'purged');
        assert.equal(await store.get(owner, receipt.receiptId), null);
      } finally {
        await callback.close();
      }
    });
    it('does not invalidate a refused owner redaction', async () => {
      const calls = [];
      const result = await executeOwnerPersonRedaction(
        {
          ownerUserId: owner,
          store: {
            listCandidateIdsForPerson: async () => ['person_candidate_coordinate'],
            getCandidateForOwner: async () => ({ writeOpportunityLineage: lineage }),
            redactItem: async () => ({ outcome: 'conflict' }),
          },
          writeOpportunityTerminalLedger: { recordInvalidated: async () => calls.push('invalidated') },
          writeOpportunityDeliveryStore: { purgeLineage: async () => calls.push('purged') },
        },
        {
          personId: 'person_coordinate',
          item: { kind: 'claim', id: 'person_claim_coordinate' },
          requestId,
          expectedRevision: `sha256:${'a'.repeat(64)}`,
        },
        { warn() {} },
      );
      assert.equal(result.outcome, 'conflict');
      assert.deepEqual(calls, []);
    });
  },
);
