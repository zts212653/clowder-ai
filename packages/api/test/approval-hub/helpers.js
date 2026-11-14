export async function createTestApprovalRegistry(adapters) {
  const [{ ApprovalProducerRegistry }, { APPROVAL_PRODUCER_IDS }] = await Promise.all([
    import('../../dist/domains/approval-hub/ApprovalProducerRegistry.js'),
    import('@cat-cafe/shared'),
  ]);
  const overrides = new Map(adapters.map((adapter) => [adapter.featureId, adapter]));
  const bindings = Object.fromEntries(
    APPROVAL_PRODUCER_IDS.map((featureId) => {
      const override = overrides.get(featureId);
      return [
        featureId,
        {
          adapter: override
            ? {
                featureId: override.featureId,
                listPending: (...args) => override.listPending(...args),
                listSettled: (...args) => override.listSettled?.(...args) ?? [],
                ...(override.listSettledPage
                  ? { listSettledPage: (...args) => override.listSettledPage(...args) }
                  : {}),
              }
            : {
                featureId,
                async listPending() {
                  return [];
                },
                async listSettled() {
                  return [];
                },
                async listSettledPage() {
                  return { records: [], frontier: null, hasMore: false };
                },
              },
          lifecycle: { contractVersion: 1, writerGeneration: featureId === 'F266' ? 'v1' : 'legacy' },
        },
      ];
    }),
  );
  return new ApprovalProducerRegistry(bindings);
}

export function anchorApproval(
  store,
  { proposalId, sourceFeatureId, ownerUserId, requesterCatId, threadId, createdAt = Date.now(), originRef },
) {
  const envelope = {
    canonicalProposalId: proposalId,
    sourceFeatureId,
    ownerUserId,
    requesterCatId,
    originRef: originRef ?? { kind: 'message', threadId, messageId: `origin-${proposalId}` },
    approvalCardRef: { threadId, messageId: `card-${proposalId}` },
    createdAt,
  };
  const committed = store.commitEnvelope(proposalId, envelope);
  return committed && typeof committed.then === 'function' ? committed.then(() => envelope) : envelope;
}

/** Publication-only suites isolate source eligibility; real ApprovalIngress and retry tests cover that policy. */
export function createTestApprovalIngress() {
  return {
    async validateOrigin() {},
    async publish(draft, store) {
      const envelope = {
        canonicalProposalId: draft.canonicalProposalId,
        sourceFeatureId: draft.producerId,
        ownerUserId: draft.ownerUserId,
        requesterCatId: draft.requesterCatId,
        originRef: draft.originRef,
        approvalCardRef: { threadId: draft.cardThreadId, messageId: `card-${draft.canonicalProposalId}` },
        createdAt: draft.createdAt,
      };
      await store.commitEnvelope(draft.canonicalProposalId, envelope);
      return envelope;
    },
  };
}

export function proposedTaskAction(overrides = {}) {
  return {
    subjectRef: 'subject:task:work-42',
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    terminalPredicate: {
      kind: 'task_done',
    },
    ...overrides,
  };
}
