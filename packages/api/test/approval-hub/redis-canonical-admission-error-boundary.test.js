import assert from 'node:assert/strict';
import test from 'node:test';

const [
  { RedisDispatchProposalStore },
  { RedisCanonicalAdmissionUnavailableError },
  { canonicalizeActionTerminalPredicate },
] = await Promise.all([
  import('../../dist/domains/approval-hub/stores/redis/RedisDispatchProposalStore.js'),
  import('../../dist/domains/approval-hub/stores/redis/RedisDispatchProposalCanonicalClaim.js'),
  import('../../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'),
]);

test('cold projection rebuild failures preserve the retryable unavailable error boundary', async () => {
  let evalCalls = 0;
  const redis = {
    options: {},
    async eval() {
      evalCalls += 1;
      return ['canonical_admission_unavailable', 'projection_not_ready'];
    },
    async get() {
      return null;
    },
    async scan() {
      throw new Error('simulated canonical projection rebuild failure');
    },
  };
  const store = new RedisDispatchProposalStore(redis);
  const subjectRef = 'pr:owner/repo#42';

  await assert.rejects(
    () =>
      store.claimActionSuccessorWithCanonicalAdmission({
        ownerUserId: 'user-1',
        canonicalActionKey: 'user-1\u001fpr:owner/repo#42\u001freview\u001freviewer',
        negativeAuthorization: {
          sourceInvocationId: 'invocation-cold-rebuild',
          sourceThreadId: 'thread-source',
          senderCatId: 'opus',
          targetThreadId: 'thread-target',
          targetCats: ['sonnet'],
          sourceInvocationCreatedAt: 1,
        },
        claimInput: {
          leaseId: 'lease-cold-rebuild',
          tenantScope: 'user-1',
          subjectRef,
          actionFamily: 'review',
          successorSlot: 'reviewer',
          mode: 'single',
          holderCatIds: ['sonnet'],
          dispatchId: 'cross-post:cold-rebuild',
          claimOrigin: 'structured_transfer',
          holderThreadId: 'thread-target',
          predecessorCatId: 'opus',
          predecessorThreadId: 'thread-source',
          issuerStandingEvidenceRef: 'callback:cold-rebuild',
          evidenceRefs: ['callback:cold-rebuild'],
          terminalPredicate: canonicalizeActionTerminalPredicate({
            actionFamily: 'review',
            subjectRef,
            predicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
          }),
          now: 1,
        },
      }),
    (error) =>
      error instanceof RedisCanonicalAdmissionUnavailableError &&
      error.message.includes('canonical admission projection rebuild failed closed'),
  );
  assert.equal(evalCalls, 1, 'the failed rebuild must not retry the atomic claim');
});
