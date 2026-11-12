import { tasteContentSnapshot } from '../../dist/domains/taste/services/taste-decision-snapshot.js';

/** Positive source dependency for publication fault tests; source rejection uses the real MessageStore suite. */
export function tasteSourceStore({ ids, userId = 'user-1', threadId = 'thread-1' }) {
  const allowed = new Set(ids);
  return {
    getById: async (id) =>
      allowed.has(id)
        ? {
            id,
            userId,
            threadId,
            from: { kind: 'user', userId },
            content: 'Exact owner source fixture',
            mentions: [],
            timestamp: 1,
          }
        : null,
  };
}

export function publicTasteApprovalEvidence(proposal) {
  if (proposal.approvalOriginRef?.kind !== 'message') throw new Error('Test proposal needs an exact original source');
  const snapshot = tasteContentSnapshot(proposal);
  if (!snapshot) throw new Error('Test proposal must have its original anchored card');
  return {
    expectedDecisionDigest: snapshot.digest,
    messageStore: tasteSourceStore({
      ids: [proposal.approvalOriginRef.messageId],
      userId: proposal.userId,
      threadId: proposal.threadId,
    }),
  };
}
