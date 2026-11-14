import { isDeepStrictEqual } from 'node:util';
import type { PersonClaimVersion } from '@cat-cafe/shared';
import type { PersonMemoryStore, StoredPersonMemoryCandidate } from './PersonMemoryStore.js';

export async function readApprovedClaimTexts(
  store: Pick<PersonMemoryStore, 'getCandidateForOwner'>,
  ownerUserId: string,
  personId: string,
  claims: readonly PersonClaimVersion[],
): Promise<Map<string, string>> {
  const candidates = new Map<string, Promise<StoredPersonMemoryCandidate | null>>();
  const texts = new Map<string, string>();
  await Promise.all(
    claims.map(async (claim) => {
      const authority = claim.materializedBy;
      if (claim.status === 'redacted' || claim.payload.kind === 'redacted' || authority.kind !== 'card_approval')
        return;
      let pending = candidates.get(authority.candidateId);
      if (!pending) {
        // Missing/settled drafts are optional presentation evidence, never a reason to hide the claim.
        pending = store.getCandidateForOwner(ownerUserId, authority.candidateId).catch(() => null);
        candidates.set(authority.candidateId, pending);
      }
      const candidate = await pending;
      if (
        !candidate ||
        candidate.ownerUserId !== ownerUserId ||
        candidate.candidateId !== authority.candidateId ||
        (candidate.materializedPersonId !== personId && candidate.targetPersonId !== personId) ||
        !candidate.approval?.approvedDraftIds.includes(authority.draftId)
      )
        return;
      const draft = candidate.claimDrafts.find((item) => item.draftId === authority.draftId);
      if (
        draft?.decision === 'approved' &&
        draft.normalizedDraft.trim() &&
        isDeepStrictEqual(draft.payload, claim.payload)
      )
        texts.set(claim.claimId, draft.normalizedDraft);
    }),
  );
  return texts;
}
