import { captureCandidateIdSchema, isPersonMemoryProposalCardBlock } from '@cat-cafe/shared';

export const PERSON_MEMORY_PROPOSAL_STATUS_TOOL = 'cat_cafe_get_person_memory_proposal_status';

/**
 * A proposal card is a snapshot of the moment it was posted; the proposal itself
 * keeps moving in the Approval Hub. This names the proposal and where its live
 * state is read, so the pointer travels with the card instead of being inferred
 * from the wording of a prompt.
 *
 * Used by the per-turn history digest only. A card that reaches a cat through a
 * forwarded or quoted message bundle, or through a message-read tool, does not
 * carry it.
 *
 * Returns null for anything that is not a proposal card with a canonical id.
 */
export function personMemoryProposalCardPointer(block: unknown): string | null {
  if (!isPersonMemoryProposalCardBlock(block)) return null;
  const candidateId = captureCandidateIdSchema.safeParse(block.meta.candidateId);
  if (!candidateId.success) return null;
  return `人物记忆提案 ${candidateId.data}，现状用 ${PERSON_MEMORY_PROPOSAL_STATUS_TOOL} 查`;
}
