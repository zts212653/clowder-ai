import { createHash } from 'node:crypto';
import {
  type EvolutionMediaLocator,
  evolutionMediaLocatorSchema,
  type ImmutableMedia,
  refIdentity,
  type WorkspaceContentReview,
  type WorkspaceContentReviewView,
  type WorkspaceContentSource,
  workspaceContentSourceSchema,
} from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from './errors.js';
import type { WorkspaceReviewPrincipal } from './service.js';
import {
  resolveMediaWorkspaceReviewAnnotations,
  resolveWorkspaceReviewVisualMarks,
} from './workspace-review-annotation-resolution.js';

/** Read-only owner port. Opening an original never invokes F138, Task admission or a Program mutation. */
export interface EvolutionMediaReadPort {
  read(
    locator: EvolutionMediaLocator,
    principal: Pick<WorkspaceReviewPrincipal, 'userId'>,
  ): Promise<{
    bytes: Buffer;
    mime: string;
    label: string;
    media: ImmutableMedia;
  }>;
}

export function evolutionContentRef(input: EvolutionMediaLocator): string {
  const target = evolutionMediaLocatorSchema.parse(input);
  return (
    'evolution-media:' +
    createHash('sha256')
      .update(
        JSON.stringify([
          target.programId,
          refIdentity(target.experimentRef),
          refIdentity(target.recordRef),
          refIdentity(target.mediaRef),
        ]),
      )
      .digest('hex')
  );
}

export async function resolveEvolutionReviewSource(
  port: EvolutionMediaReadPort | undefined,
  locator: EvolutionMediaLocator,
  principal: WorkspaceReviewPrincipal,
) {
  if (!port) throw new WorkspaceContentReviewError('source_unavailable');
  const target = evolutionMediaLocatorSchema.parse(locator);
  const read = await port.read(target, principal);
  const digest = createHash('sha256').update(read.bytes).digest('hex');
  if (digest !== target.mediaRef.version) throw new WorkspaceContentReviewError('source_changed');
  const source = workspaceContentSourceSchema.parse({
    kind: 'evolution',
    locator: target,
    revision: 'sha256:' + digest,
    mime: read.mime,
    byteLength: read.bytes.length,
    media: read.media,
    label: read.label,
  });
  return {
    contentRef: evolutionContentRef(target),
    source: source as Extract<WorkspaceContentSource, { kind: 'evolution' }>,
  };
}

export async function readEvolutionReview(
  port: EvolutionMediaReadPort | undefined,
  review: WorkspaceContentReview,
  principal: WorkspaceReviewPrincipal,
): Promise<WorkspaceContentReviewView> {
  if (review.source.kind !== 'evolution') throw new WorkspaceContentReviewError('unsupported_content');
  const resolved = await resolveEvolutionReviewSource(port, review.source.locator, principal);
  if (resolved.contentRef !== review.contentRef || resolved.source.revision !== review.source.revision)
    throw new WorkspaceContentReviewError('source_changed');
  return {
    review,
    sourceState: 'current',
    currentSource: resolved.source,
    canWrite: true,
    annotationResolutions: resolveMediaWorkspaceReviewAnnotations(review, resolved.source),
    visualMarkResolutions: resolveWorkspaceReviewVisualMarks(review, resolved.source),
  };
}
