import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { StoredPersonMemoryCandidate } from '../src/domains/memory/people/PersonMemoryStore.js';
import { projectPersonMemoryRetainedEffects } from '../src/domains/memory/people/person-memory-proposal-status.js';

test('a last-batch receipt must not be displayed as the total after multiple approvals', () => {
  const candidate = {
    candidateId: 'candidate',
    state: 'rejected',
    approval: { approvedDraftIds: ['earlier', 'last'], authorizedAt: 20 },
    latestDecisionReceipt: {
      candidateId: 'candidate',
      selectedDraftIds: ['last'],
      materializedClaimIds: ['last-claim'],
      materializedRelationshipIds: [],
      materializedEventIds: [],
    },
  } as unknown as StoredPersonMemoryCandidate;
  const result = projectPersonMemoryRetainedEffects(candidate);
  assert.equal(result.hasRetainedWrites, true);
  assert.equal(
    result.materialized,
    undefined,
    'Incomplete aggregate evidence supports written, without an invented total',
  );
  candidate.approval!.approvedDraftIds = ['last'];
  assert.deepEqual(projectPersonMemoryRetainedEffects(candidate).materialized, {
    claims: 1,
    relationships: 0,
    events: 0,
  });
});
