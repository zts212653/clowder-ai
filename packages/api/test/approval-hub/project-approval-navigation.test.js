import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectApprovalNavigation } from '../../dist/domains/approval-hub/projectApprovalNavigation.js';

const envelope = {
  canonicalProposalId: 'proposal-1',
  sourceFeatureId: 'F128',
  ownerUserId: 'user-1',
  requesterCatId: 'codex-sol',
  originRef: { kind: 'message', threadId: 'origin-thread', messageId: 'origin-message' },
  approvalCardRef: { threadId: 'card-thread', messageId: 'card-message' },
  createdAt: 1_721_111_111_111,
};

describe('projectApprovalNavigation', () => {
  it('projects exact dual anchors from an anchored publication', () => {
    assert.deepEqual(projectApprovalNavigation({ publication: { state: 'anchored', envelope } }, {}), {
      state: 'anchored',
      originRef: envelope.originRef,
      approvalCardRef: envelope.approvalCardRef,
    });
  });

  it('classifies pre-Phase-I records honestly without inventing anchors', () => {
    assert.deepEqual(projectApprovalNavigation({}, { legacyThreadId: 'thread-1' }), {
      state: 'legacy_unanchored',
      legacyThreadId: 'thread-1',
    });
  });

  it('keeps staged and tombstoned publications out of Hub projections', () => {
    assert.equal(projectApprovalNavigation({ publication: { state: 'staged', stagedAt: 1 } }, {}), null);
    assert.equal(
      projectApprovalNavigation({ publication: { state: 'tombstoned', failedAt: 2, reason: 'append failed' } }, {}),
      null,
    );
  });

  it('rejects malformed anchored publications instead of degrading to legacy navigation', () => {
    assert.throws(
      () =>
        projectApprovalNavigation(
          {
            publication: {
              state: 'anchored',
              envelope: { ...envelope, approvalCardRef: { threadId: 'card-thread', messageId: ' ' } },
            },
          },
          {},
        ),
      /approvalCardRef\.messageId must be non-empty/,
    );
  });
});
