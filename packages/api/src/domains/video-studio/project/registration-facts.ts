import type { VideoProjectDocumentV1, VideoProjectScreening } from '@cat-cafe/shared';
import type { ProjectContentOwnerService } from '../content-owner/service.js';
import { sameProjectValue } from './document-mutations.js';
import type { AppendVideoProjectScreening } from './screening-types.js';
import type { VideoProjectReadPort } from './types.js';

/** Registration facts are append-only evidence, never ordinary editable project inputs. */
export function assertProjectRegistrationFacts(
  previous: VideoProjectDocumentV1 | undefined,
  document: VideoProjectDocumentV1,
  command?: 'screening' | 'self-review',
) {
  for (const field of ['screenings', 'selfReviews'] as const) {
    const before = previous?.[field] ?? [];
    const after = document[field] ?? [];
    const append = command === (field === 'screenings' ? 'screening' : 'self-review');
    if (!sameProjectValue(before, after.slice(0, before.length)) || after.length !== before.length + (append ? 1 : 0))
      throw new TypeError('Use a dedicated registration/attestation command to append immutable project facts');
  }
}

export async function validateScreeningAppend(
  owner: ProjectContentOwnerService,
  projects: VideoProjectReadPort,
  command: Parameters<AppendVideoProjectScreening>[0],
  screening: VideoProjectScreening,
) {
  const frozen = await projects.load({ ...command, ownerRevision: screening.input.ownerRevision });
  const media = await owner.describe(screening.media.contentRef, screening.media.ownerRevision);
  const scope = media.projectMediaScope;
  if (
    screening.input.contentRef !== command.contentRef ||
    screening.input.ownerRevision > command.expectedOwnerRevision ||
    frozen.blobDigest !== screening.input.blobDigest ||
    screening.operationId !== command.operationId ||
    !sameProjectValue(screening.actor, command.principal.actor) ||
    !scope ||
    scope.ownerUserId !== command.principal.userId ||
    scope.projectContentRef !== command.contentRef ||
    scope.screeningId !== screening.id ||
    scope.snapshotOperationId !== command.operationId ||
    scope.requestDigest !== command.requestDigest ||
    !sameProjectValue(scope.input, screening.input) ||
    !sameProjectValue(scope.registeredBy, screening.actor) ||
    scope.registeredAt !== screening.at ||
    screening.media.ownerRevision !== 1 ||
    media.blobDigest !== screening.media.blobDigest ||
    media.byteLength !== screening.media.byteLength ||
    media.mediaType !== 'video/mp4'
  )
    throw new TypeError('Screening registration must bind the frozen input and scoped media evidence');
}
