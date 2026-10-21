import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { DispatchActionApprovalService } from '../dist/domains/approval-hub/DispatchActionApprovalService.js';
import { validateDispatchProposedAction } from '../dist/domains/approval-hub/DispatchProposedAction.js';
import { approveRedisDispatchProposalWithActionClaim } from '../dist/domains/approval-hub/stores/redis/RedisDispatchActionApproval.js';
import { RedisDispatchProposalStore } from '../dist/domains/approval-hub/stores/redis/RedisDispatchProposalStore.js';
import { approvedTaskFixture, OWNER, TARGET, USER } from './helpers/approved-task-contract-fixture.js';
import { revokeAtCommit } from './helpers/approved-task-readmission-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

async function dispatchFixture(t) {
  const f = await approvedTaskFixture(t);
  assert.equal((await f.continueTask()).statusCode, 200);
  const dispatches = new RedisDispatchProposalStore(f.redis);
  const service = new DispatchActionApprovalService({
    store: dispatches,
    leaseStore: f.leases,
    admissionService: f.admission,
    claimAndApprove: (proposal, user, provenance, input) =>
      approveRedisDispatchProposalWithActionClaim(f.redis, proposal, user, provenance, input),
  });
  const validated = validateDispatchProposedAction(
    {
      subjectRef: `subject:task:${f.task.id}`,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: 'single',
      terminalPredicate: { kind: 'task_done' },
    },
    [TARGET],
  );
  const { proposal } = await dispatches.create({
    proposalId: 'dispatch-approved-contract',
    sourceThreadId: f.source.id,
    targetThreadId: f.childId,
    senderCatId: OWNER,
    ownerUserId: USER,
    content: 'Implement the approved Task',
    targetCats: [TARGET],
    clientMessageId: 'dispatch-continuation',
    proposedAction: validated.action,
    envelopeDigest: validated.envelopeDigest,
    createdAt: Date.now(),
  });
  return { ...f, dispatches, approve: () => service.approve(proposal, USER, 'strict'), dispatchProposal: proposal };
}

function recoveryInput(lease) {
  return {
    expectedGeneration: lease.generation,
    expectedRevision: lease.revision,
    expectedPredicateDigest: lease.terminalPredicate.digest,
    freshnessEvidenceRef: 'task:verified:active',
    now: Date.now(),
  };
}

async function assertNoCarrier(f) {
  assert.equal((await f.queue.listAllDurable(f.childId)).length, 0);
  assert.equal((await f.messages.getByThreadAfter(f.childId, undefined, undefined, USER)).length, 2);
}

describe(
  'dispatch approval and recovery consume the same Task continuation',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  () => {
    test('atomic dispatch approval rejects revoked contract before approving or claiming', async (t) => {
      const f = await dispatchFixture(t);
      const before = await f.dispatches.get(f.dispatchProposal.proposalId);
      const assertRaced = revokeAtCommit(f);
      await assert.rejects(f.approve(), /approved Task contract changed/);
      assertRaced();
      assert.deepEqual(await f.dispatches.get(f.dispatchProposal.proposalId), before);
      assert.equal((await f.leases.listActiveTaskLeases()).length, 0);
      await assertNoCarrier(f);
    });

    for (const operation of ['recordDispatchDeliveryAttempt', 'reserveDispatchDelivery']) {
      test(`${operation} rejects revocation at its commit without new recovery state`, async (t) => {
        const f = await dispatchFixture(t);
        const approved = await f.approve();
        assert.equal(approved.approved, true);
        let lease = approved.value.actionLease;
        if (operation === 'reserveDispatchDelivery') {
          const attempted = await f.leases.recordDispatchDeliveryAttempt(lease.leaseId, recoveryInput(lease));
          assert.equal(attempted.outcome, 'recorded');
          lease = attempted.lease;
        }
        const assertRaced = revokeAtCommit(f, 'ownerCatId', 'other-owner');
        await assert.rejects(
          f.leases[operation](lease.leaseId, recoveryInput(lease)),
          /approved Task contract changed/,
        );
        assertRaced();
        assert.deepEqual(await f.leases.get(lease.leaseId), lease);
        await assertNoCarrier(f);
      });
    }

    test('valid pending dispatch can record its attempt, reserve, and acknowledge delivery', async (t) => {
      const f = await dispatchFixture(t);
      const approved = await f.approve();
      assert.equal(approved.approved, true);
      const attempted = await f.leases.recordDispatchDeliveryAttempt(
        approved.value.actionLease.leaseId,
        recoveryInput(approved.value.actionLease),
      );
      assert.equal(attempted.outcome, 'recorded');
      const reserved = await f.leases.reserveDispatchDelivery(attempted.lease.leaseId, recoveryInput(attempted.lease));
      assert.equal(reserved.outcome, 'reserved');
      const delivered = await f.leases.markDispatchDelivered(reserved.lease.leaseId, {
        ...recoveryInput(reserved.lease),
        deliveredMessageId: 'delivery:message',
        evidenceRef: 'message:delivered',
      });
      assert.equal(delivered.outcome, 'delivered');
    });
  },
);
