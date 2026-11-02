import assert from 'node:assert/strict';
import { buildPersonMemoryProposalCard } from '../../../api/dist/routes/person-memory-proposal-card.js';

/** Controlled preconditions use the real producer; browser reads remain the original HTTP path. */
export async function createPersonMemoryReplacement({ language, owner, thread, messages, store, ingress }) {
  const source = messages.append({
    userId: owner,
    threadId: thread.id,
    from: { kind: 'user', userId: owner },
    content: language === 'en' ? 'Lin enjoys hiking and lives in Hangzhou.' : '林喜欢爬山，住在杭州。',
    timestamp: Date.now(),
  });
  const publish = async (suffix, replacesProposalId) => {
    const proposalId = `person_candidate_replacement_${suffix}`;
    const draftIds = ['hobby', 'city'].map((kind) => `person_draft_replacement_${suffix}_${kind}`);
    const staged = await store.stageCandidate({
      candidateId: proposalId,
      ownerUserId: owner,
      requesterCatId: 'codex61-sol',
      sourceMessageRef: { kind: 'message', threadId: thread.id, messageId: source.id },
      personDraft: { displayName: 'Lin Replacement', privateAliases: ['Lin Replacement'] },
      ...(replacesProposalId ? { replacesProposalId } : {}),
      claimDrafts: draftIds.map((draftId, index) => ({
        draftId,
        payload: {
          kind: 'reported_fact',
          predicate: index === 0 ? 'hobby' : 'home_city',
          value: index === 0 ? 'hiking' : 'Hangzhou',
          assertedBy: 'owner',
        },
        normalizedDraft: index === 0 ? 'Lin enjoys hiking' : 'Lin lives in Hangzhou',
        sourceRole: 'owner_explicit',
        evidenceExcerpt: source.content,
        decision: 'pending',
      })),
      remainingDraftIds: draftIds,
      retention: 'owner_controlled_no_ttl',
      createdAt: Date.now(),
    });
    const envelope = await ingress.publish(
      {
        producerId: 'F276',
        canonicalProposalId: proposalId,
        ownerUserId: owner,
        requesterCatId: 'codex61-sol',
        originRef: staged.sourceMessageRef,
        cardThreadId: thread.id,
        cardContent: language === 'en' ? 'Replacement proposal.' : '替代后的提案。',
        cardBlock: buildPersonMemoryProposalCard(staged),
        createdAt: staged.createdAt,
      },
      store,
    );
    return {
      proposalId,
      draftIds,
      envelope,
      block: messages.getById(envelope.approvalCardRef.messageId).extra.rich.blocks[0],
    };
  };
  const original = await publish('original');
  const approved = await store.approveDrafts({
    ownerUserId: owner,
    candidateId: original.proposalId,
    selectedDraftIds: [original.draftIds[0]],
    decisionId: 'decision_replacement_partial',
    authorizedAt: Date.now(),
  });
  assert.equal(approved.receipt.state, 'partially_materialized');
  const undone = await store.undoDecision({
    ownerUserId: owner,
    candidateId: original.proposalId,
    decisionId: approved.receipt.decisionId,
    requestId: 'undo_replacement_partial',
    undoneAt: Date.now(),
  });
  assert.equal(undone.outcome, 'applied');
  assert.equal((await store.getCandidateForOwner(owner, original.proposalId)).state, 'pending_approval');
  const successor = await publish('successor', original.proposalId);
  const terminal = await store.getCandidateForOwner(owner, original.proposalId);
  assert.equal(terminal.state, 'withdrawn');
  assert.equal(terminal.replacedByProposalId, successor.proposalId);
  assert.equal(terminal.latestUndoReceipt.candidateState, 'pending_approval');
  assert.equal((await store.getCandidateForOwner(owner, successor.proposalId)).state, 'pending_approval');
  return { original, successor, approved: approved.receipt, undone, terminal };
}
