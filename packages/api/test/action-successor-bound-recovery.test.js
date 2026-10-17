import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ActionSuccessorDispatchRecovery } from '../dist/domains/ball-custody/ActionSuccessorDispatchRecovery.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { claimActionSuccessor } from '../dist/domains/ball-custody/action-successor-state-machine.js';

const binding = {
  pluginInstanceId: 'installed-reviewer',
  packageDigest: 'sha512-package',
  featureId: 'review',
  contributionId: 'review-predicate',
  freshnessMethod: 'review.freshness',
  completionMethod: 'review.completion',
  grantRevision: 2,
  lifecycleRevision: 3,
  tenantScope: 'owner',
  installationProjectRoot: '/isolated/project',
};
function fixture({
  reserved = false,
  task = false,
  legacy = false,
  unavailable = false,
  missingPort = false,
  forgedOwner = false,
  revokeAfterFreshness = false,
} = {}) {
  const predicate = canonicalizeActionTerminalPredicate(
    task
      ? { actionFamily: 'implement', subjectRef: 'subject:task:task-1', predicate: { kind: 'task_done' } }
      : {
          actionFamily: 'review',
          subjectRef: 'pr:owner/repo#42',
          predicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
        },
  );
  let lease = claimActionSuccessor(null, {
    leaseId: 'lease-1',
    tenantScope: 'owner',
    subjectRef: predicate.subjectRef,
    actionFamily: task ? 'implement' : 'review',
    successorSlot: task ? 'implementer' : 'reviewer',
    mode: 'single',
    holderCatIds: ['reviewer'],
    holderThreadId: 'target',
    predecessorCatId: 'author',
    predecessorThreadId: 'source',
    dispatchId: 'approval:proposal-1',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'approval:proposal-1',
    evidenceRefs: ['approval:proposal-1'],
    now: 100,
    terminalPredicate: predicate,
    ...(!task && !legacy ? { terminalPredicateProviderBinding: binding } : {}),
  }).lease;
  lease = {
    ...lease,
    dispatchDeliveryState: 'pending',
    ...(reserved
      ? {
          dispatchDeliveryReservation: {
            predicateDigest: predicate.digest,
            freshnessEvidenceRef: 'github:reserved',
            reservedAt: 101,
          },
        }
      : {}),
  };
  const proposal = {
    proposalId: 'proposal-1',
    status: 'approved',
    sourceThreadId: 'source',
    targetThreadId: 'target',
    senderCatId: 'author',
    ownerUserId: forgedOwner ? 'other-owner' : 'owner',
    targetCats: ['reviewer'],
    actionLeaseRef: {
      leaseId: lease.leaseId,
      generation: lease.generation,
      dispatchId: lease.dispatchId,
      terminalPredicateDigest: predicate.digest,
    },
  };
  const observations = { authorization: [], ordinaryFreshness: 0, boundFreshness: 0, writes: [], deliveries: 0 };
  let inGuard = false;
  let authorityCurrent = true;
  const fresh = {
    status: 'verified',
    evidenceRef: 'github:head',
    freshnessKey: predicate.freshnessKey,
    ownerCatId: 'reviewer',
    holderThreadId: 'target',
    tenantScope: 'owner',
  };
  const record = (name) => observations.writes.push({ name, guarded: inGuard });
  const recovery = new ActionSuccessorDispatchRecovery({
    now: () => 200,
    leaseStore: {
      recordDispatchDeliveryAttempt: async () => {
        record('attempt');
        lease = { ...lease, revision: lease.revision + 1 };
        return { outcome: 'recorded', lease };
      },
      reserveDispatchDelivery: async () => {
        record('reserve');
        lease = {
          ...lease,
          revision: lease.revision + 1,
          dispatchDeliveryReservation: {
            predicateDigest: predicate.digest,
            freshnessEvidenceRef: fresh.evidenceRef,
            reservedAt: 200,
          },
        };
        return { outcome: 'reserved', lease };
      },
      markDispatchDelivered: async () => {
        lease = { ...lease, dispatchDeliveryState: 'delivered', dispatchDeliveredMessageId: 'message-1' };
        return { outcome: 'delivered', lease };
      },
      markDispatchFailed: async (_id, input) => {
        lease = { ...lease, dispatchDeliveryState: 'failed', dispatchFailureReason: input.reason };
        return { outcome: 'failed', lease };
      },
    },
    truthResolver: {
      resolveFreshness: async () => {
        observations.ordinaryFreshness++;
        return fresh;
      },
      ...(!missingPort
        ? {
            authorizeDispatchRecovery: async (frozen, context) => {
              observations.authorization.push({ frozen, context });
              if (unavailable) return { status: 'insufficient', reason: 'persisted installation revoked' };
              return {
                status: 'authorized',
                withAuthority: async (operation) => {
                  assert.equal(authorityCurrent, true, 'provider revoked');
                  assert.equal(inGuard, false);
                  inGuard = true;
                  try {
                    return await operation();
                  } finally {
                    inGuard = false;
                  }
                },
                resolveFreshness: async () => {
                  assert.equal(inGuard, false, 'provider IO must be outside inventory authority');
                  observations.boundFreshness++;
                  if (revokeAfterFreshness) authorityCurrent = false;
                  return fresh;
                },
              };
            },
          }
        : {}),
    },
    loadProposal: async () => proposal,
    loadOwnerAuthProvenance: async () => 'strict',
    recordProposalDelivery: async () => {},
    deliver: async () => {
      observations.deliveries++;
      return { outcome: 'enqueued', deliveredMessageId: 'message-1' };
    },
  });
  return { run: () => recovery.recover(lease), observations, initial: structuredClone(lease) };
}

test('bound recovery uses exact lease binding and authenticated proposal actor instead of reselection', async () => {
  const f = fixture();
  assert.equal((await f.run()).outcome, 'delivered');
  assert.equal(f.observations.authorization.length, 1, 'bound recovery authority entry was not called');
  assert.deepEqual(f.observations.authorization[0], {
    frozen: f.initial,
    context: {
      tenantScope: 'owner',
      actorCatId: 'author',
      sourceThreadId: 'source',
      targetThreadId: 'target',
      holderCatIds: ['reviewer'],
    },
  });
  assert.equal(f.observations.ordinaryFreshness, 0, 'existing lease must not select a current provider');
  assert.equal(f.observations.boundFreshness, 1);
});

test('bound recovery serializes attempt and reservation with installation authority', async () => {
  const f = fixture();
  await f.run();
  assert.deepEqual(f.observations.writes, [
    { name: 'attempt', guarded: true },
    { name: 'reserve', guarded: true },
  ]);
});

test('a reserved dispatch cannot bypass a revoked persisted provider', async () => {
  const f = fixture({ reserved: true, unavailable: true });
  assert.equal((await f.run()).outcome, 'pending');
  assert.equal(f.observations.deliveries, 0);
});

test('bound reserved recovery without an authority port fails closed', async () => {
  const f = fixture({ reserved: true, missingPort: true });
  assert.equal((await f.run()).outcome, 'pending');
  assert.equal(f.observations.deliveries, 0);
});

test('proposal owner mismatch never becomes recovery principal or delivery authority', async () => {
  const f = fixture({ reserved: true, forgedOwner: true });
  assert.notEqual((await f.run()).outcome, 'delivered');
  assert.equal(f.observations.authorization.length, 0);
  assert.equal(f.observations.deliveries, 0);
});

test('legacy review reservation is not silently rebound to the currently installed provider', async () => {
  const f = fixture({ reserved: true, legacy: true });
  assert.equal((await f.run()).outcome, 'pending');
  assert.equal(f.observations.deliveries, 0);
});

test('ordinary task recovery still uses the original task freshness resolver', async () => {
  const f = fixture({ task: true });
  assert.equal((await f.run()).outcome, 'delivered');
  assert.equal(f.observations.ordinaryFreshness, 1);
  assert.equal(f.observations.authorization.length, 0);
});

test('authorized reserved recovery preserves its durable reservation without repeating provider HEAD IO', async () => {
  const f = fixture({ reserved: true });
  assert.equal((await f.run()).outcome, 'delivered');
  assert.equal(f.observations.authorization.length, 1);
  assert.equal(f.observations.boundFreshness, 0);
  assert.equal(f.observations.ordinaryFreshness, 0);
});

test('revocation after background freshness prevents both reservation and delivery', async () => {
  const f = fixture({ revokeAfterFreshness: true });
  await assert.rejects(() => f.run(), /provider revoked/);
  assert.equal(f.observations.boundFreshness, 1);
  assert.deepEqual(f.observations.writes, []);
  assert.equal(f.observations.deliveries, 0);
});
