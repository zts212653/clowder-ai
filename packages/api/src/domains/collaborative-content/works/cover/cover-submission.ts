import type { SubmitWork, WorkReference } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../../video-studio/content-owner/media-errors.js';
import type { WorkPrincipal } from '../types.js';
import type { WorkCoverService } from './cover-service.js';
import { coverSourceReadable, resolveCoverPick } from './cover-sources.js';
import type { FrozenSubmitCover } from './cover-store.js';

/**
 * Decide the new version's cover before the owner saves the film, once per operation. A retry reuses
 * this first decision, so a later edit of the previous version can never reach the saved new version.
 */
export async function freezeSubmitCover(
  covers: WorkCoverService | undefined,
  command: SubmitWork,
  principal: WorkPrincipal,
  requestDigest: string,
  mediaType: string,
): Promise<FrozenSubmitCover | null> {
  if (mediaType !== 'video/mp4') {
    if (command.cover) throw new MediaOwnerError('invalid_media');
    return null;
  }
  if (!covers) {
    if (command.cover) throw new MediaOwnerError('media_unavailable');
    return null;
  }
  const store = covers.deps.store;
  const kept = store.frozenSubmission(principal.userId, command.contentRef, command.operationId);
  if (kept) {
    if (kept.requestDigest !== requestDigest) throw new MediaOwnerError('publication_changed');
    // A retried explicit picture is still this caller adopting it: its source must be readable now.
    await assertSubmitCoverSource(covers, kept, principal);
    return kept;
  }
  const base = { contentRef: command.contentRef, operationId: command.operationId, requestDigest };
  const mode = command.cover?.mode ?? 'inherit';
  let decided: FrozenSubmitCover;
  if (mode === 'frame') decided = { ...base, image: null, basis: { kind: 'submitted' }, record: true };
  else if (command.cover?.mode === 'image') {
    const work = { contentRef: command.contentRef, ownerRevision: command.expectedOwnerRevision };
    decided = {
      ...base,
      image: await resolveCoverPick(covers.deps, work, command.cover.pick, principal),
      basis: { kind: 'submitted' },
      record: true,
    };
  } else {
    const previous = store.get(principal.userId, {
      contentRef: command.contentRef,
      ownerRevision: command.expectedOwnerRevision,
    });
    // Inheriting copies the previous version's own recorded choice, including a clearing. Never chosen stays none.
    decided = previous
      ? {
          ...base,
          image: previous.image,
          basis: {
            kind: 'inherited',
            fromOwnerRevision: command.expectedOwnerRevision,
            fromCoverRevision: previous.coverRevision,
          },
          record: true,
        }
      : { ...base, image: null, basis: { kind: 'submitted' }, record: false };
  }
  return store.freezeSubmission(principal.userId, decided, () => decided);
}

/**
 * An explicit picture in a submit is adopted by this caller: check its source again inside the owner's final
 * effect authorization, so a withdrawal while the film is being saved refuses the whole submit. Inherited
 * choices keep their recorded state (possibly unavailable) and are not new adoptions.
 */
export async function assertSubmitCoverSource(
  covers: WorkCoverService | undefined,
  frozen: FrozenSubmitCover | null,
  principal: WorkPrincipal,
) {
  if (!covers || !frozen?.image || frozen.basis.kind !== 'submitted') return;
  if (!(await coverSourceReadable(covers.deps, frozen.image, principal)))
    throw new MediaOwnerError('media_unavailable');
}

/** Record the saved version's first cover from its frozen decision; the same retry writes nothing new. */
export function projectSubmitCover(
  covers: WorkCoverService | undefined,
  principal: WorkPrincipal,
  reference: WorkReference,
  operationId: string,
) {
  if (!covers) return;
  const frozen = covers.deps.store.frozenSubmission(principal.userId, reference.contentRef, operationId);
  if (!frozen) return;
  covers.deps.store.projectSubmission(principal.userId, reference, frozen, principal.actor);
}
