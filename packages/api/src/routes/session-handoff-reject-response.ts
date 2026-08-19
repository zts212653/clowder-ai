import type { HumanDispositionFeedbackInput, SessionHandoffProposal } from '@cat-cafe/shared';
import type { FastifyReply } from 'fastify';
import type { SessionHandoffRejectionResult } from '../domains/cats/services/stores/ports/SessionHandoffDisposition.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export type SessionHandoffRejectSignal = (input: {
  proposalId: string;
  catId: string;
  threadId: string;
  rejectionReason?: string;
}) => void;

export function respondToSessionHandoffRejection(input: {
  transition: SessionHandoffRejectionResult;
  proposal: SessionHandoffProposal;
  feedback?: HumanDispositionFeedbackInput;
  userId: string;
  reply: FastifyReply;
  socketManager: SocketManager;
  onProposalReject?: SessionHandoffRejectSignal;
}): object {
  const { transition, proposal, feedback, userId, reply, socketManager, onProposalReject } = input;
  if (transition.outcome === 'legacy_unmigrated') {
    reply.status(409);
    return {
      error: 'Legacy rejected proposal has no disposition ledger entry',
      reason: 'legacy_disposition_unmigrated',
      status: transition.proposal?.status,
    };
  }
  if (transition.outcome === 'invariant_failure') {
    reply.status(500);
    return { error: 'Disposition ledger invariant failure', reason: 'disposition_invariant_failure' };
  }
  if (transition.outcome === 'conflict') {
    reply.status(409);
    return {
      error: 'Rejected proposal feedback conflicts with the settled decision',
      status: transition.proposal?.status,
    };
  }
  if (transition.outcome === 'not_available' || !transition.proposal) {
    reply.status(409);
    return { error: 'Proposal is being approved — cannot reject; retry once it settles' };
  }

  const marked = transition.proposal;
  if (transition.outcome === 'replayed') {
    return { proposalId: marked.proposalId, status: marked.status, deduped: true };
  }
  socketManager.emitToUser(userId, 'proposal_updated', marked);
  if (onProposalReject) {
    try {
      onProposalReject({
        proposalId: proposal.proposalId,
        catId: proposal.sourceCatId,
        threadId: proposal.sourceThreadId,
        rejectionReason: feedback?.reasonCode,
      });
    } catch {
      // F192 is an eval signal, not the F281 durability source.
    }
  }
  return { proposalId: marked.proposalId, status: marked.status };
}
