import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequestReviewOwnerActions } from '../dist/infrastructure/capability-evolution/change/request-review-owner-actions.js';

const targetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};
const snapshot = {
  status: 'resolved',
  ownerRef: { ownerFeatureId: 'F100', ownerStateRef: 'owner:request-review-v1' },
  ownerAuthorizationRef: { ownerFeatureId: 'F100', ownerStateRef: 'authorization:request-review-1' },
  targetVersionRef,
  dispatchRef: { ownerFeatureId: 'F100', ownerStateRef: 'dispatch:request-review-1' },
};

describe('F100 request-review seven owner verbs', () => {
  it('observes and authorizes only the current exact target, then delegates every stateful owner fact', async () => {
    const calls = [];
    const actions = createRequestReviewOwnerActions({
      resolveCurrentSnapshot: async () => snapshot,
      dispatcher: {
        async materialize(input) {
          calls.push({ operation: 'mutate', input });
          return {
            status: 'materialized',
            receipt: { taskRef: input.caseRef, leaseRef: input.ownerRef, custodyReceiptRef: input.dispatchRef },
          };
        },
      },
      versionVerifier: {
        async verifyCommitVersion(commitSha, ref) {
          return commitSha === 'b'.repeat(40) && ref.version === 'c'.repeat(64);
        },
        async isKnownVersion() {
          return true;
        },
      },
      receipts: {
        async recordChanged(input) {
          calls.push({ operation: 'writeback', input });
          return { status: 'recorded', receiptRef: snapshot.dispatchRef };
        },
        async recordNoChange() {
          throw new Error('not used');
        },
        async recordFreshOutcome(input) {
          calls.push({ operation: 'freshOutcome', input });
          return { status: 'recorded', receiptRef: snapshot.dispatchRef };
        },
        async recordRollback(input) {
          calls.push({ operation: 'rollback', input });
          return { status: 'recorded', receiptRef: snapshot.dispatchRef };
        },
      },
    });

    assert.equal((await actions.observe({})).status, 'observed');
    assert.equal(
      (
        await actions.permission({
          targetVersionRef: { ...targetVersionRef, version: 'd'.repeat(64) },
          ownerAuthorizationRef: snapshot.ownerAuthorizationRef,
        })
      ).code,
      'target_drift',
    );
    assert.equal(
      (await actions.permission({ targetVersionRef, ownerAuthorizationRef: snapshot.ownerAuthorizationRef })).status,
      'authorized',
    );

    const dispatchInput = {
      dispatchId: 'dispatch-1',
      caseRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-case:case-1' },
      proposalRef: { ownerFeatureId: 'F266', ownerStateRef: 'eval-repair-proposal:proposal-1' },
      approvalRef: { ownerFeatureId: 'F246', ownerStateRef: 'approval:proposal-1' },
      ...snapshot,
    };
    assert.equal((await actions.mutate(dispatchInput)).status, 'materialized');
    assert.equal(
      (
        await actions.verify({
          mainCommitSha: 'b'.repeat(40),
          candidateVersionRef: { ...targetVersionRef, version: 'c'.repeat(64) },
        })
      ).status,
      'verified',
    );
    assert.equal((await actions.writeback({ type: 'changed', proposalId: 'proposal-1' })).status, 'recorded');
    assert.equal((await actions.freshOutcome({ type: 'fresh_outcome', proposalId: 'proposal-1' })).status, 'recorded');
    assert.equal((await actions.rollback({ type: 'rollback', proposalId: 'proposal-1' })).status, 'recorded');
    assert.deepEqual(
      calls.map((call) => call.operation),
      ['mutate', 'writeback', 'freshOutcome', 'rollback'],
    );
  });
});
