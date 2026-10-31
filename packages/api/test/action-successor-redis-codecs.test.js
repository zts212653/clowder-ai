import assert from 'node:assert/strict';
import { it } from 'node:test';

const { parseActionSuccessorLease } = await import('../dist/domains/ball-custody/action-successor-redis-codecs.js');

it('normalizes a singleton completion candidate into the holder-keyed schema', () => {
  const lease = parseActionSuccessorLease(
    JSON.stringify({
      leaseId: 'lease-legacy-candidate',
      key: 'user-1\u001fpr:owner/repo#2868\u001freview\u001freviewer',
      tenantScope: 'user-1',
      subjectRef: 'pr:owner/repo#2868',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      holderCatIds: ['codex-terra'],
      dispatchId: 'dispatch-1',
      generation: 1,
      status: 'active',
      holderOutcomes: {},
      completionCandidate: {
        catId: 'codex-terra',
        evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
        recordedAt: 110,
      },
      evidenceRefs: ['message:request-1'],
      revision: 2,
      createdAt: 100,
      updatedAt: 110,
    }),
  );

  assert.deepEqual(lease.completionCandidates, {
    'codex-terra': {
      evidenceRefs: ['community:pr:owner/repo#2868:review:g1'],
      candidateRevision: 1,
      evidenceDigest: lease.completionCandidates['codex-terra'].evidenceDigest,
      recordedAt: 110,
    },
  });
  assert.match(lease.completionCandidates['codex-terra'].evidenceDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(lease, 'completionCandidate'), false);
  assert.deepEqual(lease.terminalPredicateState, { kind: 'legacy_predicate_absent' });
});
