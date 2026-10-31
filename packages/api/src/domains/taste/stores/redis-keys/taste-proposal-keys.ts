/**
 * F221 Phase B: Redis key patterns for TasteProposal store.
 */
import { createHash } from 'node:crypto';

export const TasteProposalKeys = {
  detail: (id: string) => `taste-proposal:${id}`,
  userPending: (userId: string) => `taste-proposal-user-pending:${userId}`,
  userSettled: (userId: string) => `taste-proposal-user-settled:${userId}`,
  dedup: (userId: string, clientRequestId: string) => `taste-proposal-dedup:${userId}::${clientRequestId}`,
  decisionAuthority: (userId: string, proposalId: string) =>
    `taste-proposal-decision-authority:${userId}:${proposalId}`,
  correctionSource: (userId: string, sourceAnchor: string) =>
    `taste-proposal-correction-source:${createHash('sha256').update(`${userId}\0${sourceAnchor}`).digest('hex')}`,
  noCorrectionSource: 'taste-proposal-correction-source:none',
} as const;
