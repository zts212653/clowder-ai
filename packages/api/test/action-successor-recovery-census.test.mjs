import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { RedisActionSuccessorLeaseStore } from '../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js';

function returnedLease(overrides = {}) {
  return {
    leaseId: 'lease-valid',
    key: 'user-1\nsubject:task:task-1\nimplement\nimplementer',
    tenantScope: 'user-1',
    subjectRef: 'subject:task:task-1',
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['codex-sol'],
    holderThreadId: 'thread-source',
    predecessorCatId: 'codex-astra',
    predecessorThreadId: 'thread-review',
    issuerStandingEvidenceRef: 'grounding:return-1',
    dispatchId: 'return:lease-valid:g2',
    claimOrigin: 'structured_transfer',
    generation: 2,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    evidenceRefs: ['grounding:return-1'],
    returnDeliveryState: 'pending',
    returnDeliveryEvidenceRef: 'grounding:return-1',
    returnDeliveryAttemptCount: 0,
    returnDeliverySlaUntil: 2_000,
    returnTransitions: [],
    terminalPredicateState: { kind: 'legacy_predicate_absent' },
    revision: 2,
    createdAt: 500,
    updatedAt: 1_000,
    ...overrides,
  };
}

function redisFixture(rawByKey, keys = Object.keys(rawByKey)) {
  return {
    options: { keyPrefix: '' },
    async get() {
      return rawByKey[keys[0]] ?? null;
    },
    async smembers() {
      return keys;
    },
    async mget(...batch) {
      return batch.map((key) => rawByKey[key] ?? null);
    },
  };
}

describe('ActionSuccessor recovery census isolation', () => {
  test('one malformed lease cannot starve a valid pending return in the same Redis batch', async () => {
    const malformed = returnedLease({
      leaseId: 'lease-malformed',
      completionCandidates: {
        'codex-sol': { evidenceRefs: [], candidateRevision: 1, recordedAt: 900 },
      },
    });
    const valid = returnedLease();
    const store = new RedisActionSuccessorLeaseStore(
      redisFixture({
        'detail:malformed': JSON.stringify(malformed),
        'detail:valid': JSON.stringify(valid),
      }),
    );

    const pending = await store.listPendingReturns();

    assert.deepEqual(
      pending.map((lease) => lease.leaseId),
      ['lease-valid'],
      'recovery must remain live for valid records while leaving the malformed record untouched',
    );
  });

  test('exact reads remain strict for a malformed lease', async () => {
    const malformed = returnedLease({
      leaseId: 'lease-malformed',
      completionCandidates: {
        'codex-sol': { evidenceRefs: [], candidateRevision: 1, recordedAt: 900 },
      },
    });
    const store = new RedisActionSuccessorLeaseStore(redisFixture({ 'detail:malformed': JSON.stringify(malformed) }));

    await assert.rejects(store.get('lease-malformed'), /machine-checkable completion evidence/);
  });
});
