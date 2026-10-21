import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { ActionSuccessorKeys } from '../dist/domains/ball-custody/action-successor-keys.js';
import { OWNER, TARGET } from './helpers/approved-task-contract-fixture.js';
import {
  assertUnchanged,
  refreshInput,
  replacementInput,
  returnToOwner,
  revokeAtCommit,
  runningFixture,
} from './helpers/approved-task-readmission-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

describe(
  'continuation authority at every readmission commit',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  () => {
    test('replacement callback rejects a commit race without advancing lease or publishing another carrier', async (t) => {
      const f = await runningFixture(t);
      const committed = await f.leases.commitOutcome(f.lease.leaseId, {
        generation: f.lease.generation,
        catId: TARGET,
        outcome: 'unavailable',
        evidenceRef: 'unavailable:target',
        now: Date.now(),
      });
      assert.equal(committed.outcome, 'recorded');
      const before = await f.leases.get(f.lease.leaseId);
      assert.equal(before.holderOutcomes[TARGET].outcome, 'unavailable');
      const assertRaced = revokeAtCommit(f);
      const reply = await f.implement({
        clientMessageId: 'replacement-after-revocation',
        action: {
          subjectRef: before.subjectRef,
          actionFamily: 'implement',
          successorSlot: 'implementer',
          mode: 'single',
          claimOrigin: 'structured_transfer',
          terminalPredicate: { kind: 'task_done' },
          replace: { leaseId: before.leaseId, expectedGeneration: before.generation },
        },
      });
      assertRaced();
      assert.notEqual(reply.statusCode, 200, reply.body);
      await assertUnchanged(f, before);
    });

    test('handled-carrier refresh rejects a commit race without a new generation', async (t) => {
      const f = await runningFixture(t);
      const assertRaced = revokeAtCommit(f);
      await assert.rejects(
        f.leases.refreshHandledCarrier(f.lease.leaseId, refreshInput(f.lease)),
        /approved Task contract changed/,
      );
      assertRaced();
      await assertUnchanged(f, f.lease);
    });

    test('returned-holder reattach rechecks the destination receipt at commit', async (t) => {
      const f = await runningFixture(t);
      const before = await returnToOwner(f);
      const assertRaced = revokeAtCommit(f);
      await assert.rejects(
        f.leases.replace(before.leaseId, {
          ...replacementInput(f, before),
          returnedHolderCatId: OWNER,
          returnedHolderThreadId: f.source.id,
          returnProof: { kind: 'return_delivery', evidenceRef: 'queue:return:delivered' },
          freshnessEvidenceRef: 'task:current',
        }),
        /approved Task contract changed/,
      );
      assertRaced();
      await assertUnchanged(f, before);
    });

    test('unchanged contract allows refresh, owner return and exact delegate reattach', async (t) => {
      const f = await runningFixture(t);
      const refreshed = await f.leases.refreshHandledCarrier(f.lease.leaseId, refreshInput(f.lease));
      assert.equal(refreshed.outcome, 'refreshed');
      f.lease = refreshed.lease;
      const returned = await returnToOwner(f);
      const attached = await f.leases.replace(returned.leaseId, {
        ...replacementInput(f, returned),
        returnedHolderCatId: OWNER,
        returnedHolderThreadId: f.source.id,
        returnProof: { kind: 'return_delivery', evidenceRef: 'queue:return:delivered' },
        freshnessEvidenceRef: 'task:current',
      });
      assert.equal(attached.outcome, 'reattached');
      assert.equal(
        (
          await f.leases.preflight(
            attached.lease.leaseId,
            attached.lease.generation,
            attached.lease.terminalPredicate.digest,
          )
        ).ok,
        true,
      );
    });

    test('contract revocation still allows rejection to return to the canonical owner', async (t) => {
      const f = await runningFixture(t);
      await f.tasks.update(f.task.id, { title: 'Changed contract' });
      const returned = await returnToOwner(f);
      assert.deepEqual(returned.holderCatIds, [OWNER]);
      assert.equal(
        (await f.leases.preflight(returned.leaseId, returned.generation, returned.terminalPredicate.digest)).ok,
        true,
      );
    });

    test('unchanged contract allows a replacement callback and exactly one additional carrier', async (t) => {
      const f = await runningFixture(t);
      const committed = await f.leases.commitOutcome(f.lease.leaseId, {
        generation: f.lease.generation,
        catId: TARGET,
        outcome: 'unavailable',
        evidenceRef: 'unavailable:target',
        now: Date.now(),
      });
      assert.equal(committed.outcome, 'recorded');
      assert.equal((await f.leases.get(f.lease.leaseId)).holderOutcomes[TARGET].outcome, 'unavailable');
      const reply = await f.implement({
        clientMessageId: 'valid-replacement',
        action: {
          subjectRef: f.lease.subjectRef,
          actionFamily: 'implement',
          successorSlot: 'implementer',
          mode: 'single',
          terminalPredicate: { kind: 'task_done' },
          replace: { leaseId: f.lease.leaseId, expectedGeneration: f.lease.generation },
        },
      });
      assert.equal(reply.statusCode, 200, reply.body);
      assert.equal((await f.leases.get(f.lease.leaseId)).generation, 2);
      assert.equal((await f.queue.listAllDurable(f.childId)).length, 2);
    });

    test('fresh revision from a legacy predicate-absent completed lease checks receipt before successor write', async (t) => {
      const f = await runningFixture(t);
      const candidate = (
        await f.leases.recordCompletionCandidate(f.lease.leaseId, {
          generation: 1,
          catId: TARGET,
          evidenceRefs: [`task:${f.task.id}:done`],
          now: Date.now(),
        })
      ).lease.completionCandidates[TARGET];
      const completed = await f.leases.commitCompletionVerdict(f.lease.leaseId, {
        generation: 1,
        catId: TARGET,
        now: Date.now(),
        verdict: {
          status: 'verified',
          evidenceRef: `task:${f.task.id}:done`,
          predicateDigest: f.lease.terminalPredicate.digest,
          freshnessKey: f.lease.terminalPredicate.freshnessKey,
          candidateRevision: candidate.candidateRevision,
          evidenceDigest: candidate.evidenceDigest,
        },
      });
      assert.equal(completed.lease.status, 'completed');
      // Rolling legacy data: task_done has stable freshness, so ordinary task_done cannot take this branch.
      const legacy = {
        ...completed.lease,
        terminalPredicate: undefined,
        terminalPredicateState: { kind: 'legacy_predicate_absent' },
      };
      await f.redis.set(ActionSuccessorKeys.detail(legacy.leaseId), JSON.stringify(legacy));
      const before = await f.leases.get(legacy.leaseId);
      const assertRaced = revokeAtCommit(f);
      await assert.rejects(
        f.leases.continueFreshRevision(legacy.leaseId, {
          ...replacementInput(f),
          successorLeaseId: 'fresh-successor',
          claimOrigin: 'structured_transfer',
          issuerStandingEvidenceRef: 'callback:fresh-revision',
          delegateEvidenceRef: f.lease.evidenceRefs.find((ref) => ref.includes(':continuation:')),
        }),
        /approved Task contract changed/,
      );
      assertRaced();
      await assertUnchanged(f, before);
      assert.equal(await f.leases.get('fresh-successor'), null);
      assert.equal((await f.leases.getByIdentity(before)).leaseId, before.leaseId);
    });
  },
);
