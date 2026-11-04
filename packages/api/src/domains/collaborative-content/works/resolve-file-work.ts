import type { WorkWorkspaceSource } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { WorkSourcePort } from './service.js';
import type { WorkAuthorizationInput, WorkPrincipal, WorkReadResult } from './types.js';
import { workCardArtifact } from './work-card-artifact.js';

/** A locator is never an alias for an entire work. Resolve only its exact authorized source version. */
export async function resolveFileWork(
  deps: {
    owner: Pick<ProjectContentOwnerService, 'findSourcePublications'>;
    source: WorkSourcePort;
    authorize(input: WorkAuthorizationInput): Promise<void>;
    read(reference: { contentRef: string; ownerRevision: number }, principal: WorkPrincipal): Promise<WorkReadResult>;
  },
  locator: Omit<WorkWorkspaceSource, 'expectedSourceRevision'>,
  principal: WorkPrincipal,
) {
  await deps.authorize({ principal, permission: 'read' });
  const opened = await deps.source.openCurrent({ locator, principal, threadId: principal.threadId });
  opened.stream.destroy();
  await opened.revalidate();
  const source = opened.publication;
  const candidates = (
    await deps.owner.findSourcePublications({
      ownerUserId: principal.userId,
      sourceRef: source.sourceRef,
      artifactRef: source.artifactRef,
      revisions: [source.revision],
    })
  ).filter((candidate) => candidate.contentRef.startsWith('work:'));
  // Known inaccessible/ambiguous work must not silently fall back to a fresh file opinion ledger.
  const works = await Promise.all(
    candidates.map(({ contentRef, ownerRevision }) => deps.read({ contentRef, ownerRevision }, principal)),
  );
  await opened.revalidate();
  await deps.authorize({ principal, permission: 'read' });
  if (works.length > 1) throw new MediaOwnerError('publication_changed');
  return { artifact: works[0] ? workCardArtifact(works[0]) : null };
}
