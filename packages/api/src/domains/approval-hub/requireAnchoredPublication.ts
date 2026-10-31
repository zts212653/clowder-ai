import type { ApprovalEnvelope } from '@cat-cafe/shared';
import { validateApprovalEnvelope } from '@cat-cafe/shared';
import type { ApprovalPublicationReader } from './ports/ApprovalPublicationStore.js';

export class ApprovalPublicationNotAnchoredError extends Error {
  readonly statusCode = 409;
  readonly code = 'APPROVAL_PUBLICATION_NOT_ANCHORED';

  constructor(
    readonly proposalId: string,
    readonly publicationState: 'staged' | 'tombstoned',
  ) {
    super(`Approval publication ${proposalId} is ${publicationState}; retry publication before deciding`);
    this.name = 'ApprovalPublicationNotAnchoredError';
  }
}

/**
 * Decision commit guard. Phase-I staged/tombstoned records cannot cross into
 * feature business CAS. Pre-I records (no publication metadata or explicit
 * legacy_unanchored) remain decidable for backwards compatibility.
 */
export async function requireAnchoredPublication(
  store: ApprovalPublicationReader,
  proposalId: string,
): Promise<ApprovalEnvelope | null> {
  const publication = await store.getPublication(proposalId);
  if (publication === null || publication.state === 'legacy_unanchored') return null;
  if (publication.state === 'anchored') {
    validateApprovalEnvelope(publication.envelope);
    return publication.envelope;
  }
  throw new ApprovalPublicationNotAnchoredError(proposalId, publication.state);
}
