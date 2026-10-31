/** Shared terminal-state conflicts for F128 user approve/reject decisions. */

import type { ThreadProposal } from '@cat-cafe/shared';
import type { FastifyReply } from 'fastify';

type ProposalDecision = 'approve' | 'reject';

export function replyToProposalTerminalConflict(
  proposal: ThreadProposal,
  decision: ProposalDecision,
  reply: FastifyReply,
): boolean {
  let error: string | undefined;
  if (proposal.status === 'withdrawn') error = 'Proposal withdrawn by requester';
  else if (decision === 'approve' && proposal.status === 'rejected') error = 'Proposal already rejected';
  else if (decision === 'reject' && proposal.status === 'approved') error = 'Proposal already approved';
  if (!error) return false;

  reply.status(409).send({ error, status: proposal.status });
  return true;
}
