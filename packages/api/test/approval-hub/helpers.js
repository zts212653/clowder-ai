export async function createTestApprovalRegistry(adapters) {
  const [{ ApprovalProducerRegistry }, { APPROVAL_PRODUCER_IDS }] = await Promise.all([
    import('../../dist/domains/approval-hub/ApprovalProducerRegistry.js'),
    import('@cat-cafe/shared'),
  ]);
  const overrides = new Map(adapters.map((adapter) => [adapter.featureId, adapter]));
  const bindings = Object.fromEntries(
    APPROVAL_PRODUCER_IDS.map((featureId) => [
      featureId,
      {
        adapter: overrides.get(featureId) ?? {
          featureId,
          async listPending() {
            return [];
          },
          async listSettled() {
            return [];
          },
        },
      },
    ]),
  );
  return new ApprovalProducerRegistry(bindings);
}

export function anchorApproval(
  store,
  { proposalId, sourceFeatureId, ownerUserId, requesterCatId, threadId, createdAt = Date.now() },
) {
  const envelope = {
    canonicalProposalId: proposalId,
    sourceFeatureId,
    ownerUserId,
    requesterCatId,
    originRef: { kind: 'message', threadId, messageId: `origin-${proposalId}` },
    approvalCardRef: { threadId, messageId: `card-${proposalId}` },
    createdAt,
  };
  const committed = store.commitEnvelope(proposalId, envelope);
  return committed && typeof committed.then === 'function' ? committed.then(() => envelope) : envelope;
}

export function proposedReviewAction(overrides = {}) {
  return {
    subjectRef: 'pr:owner/repo#42',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    terminalPredicate: {
      kind: 'review_delivered',
      headSha: 'a'.repeat(40),
    },
    ...overrides,
  };
}
