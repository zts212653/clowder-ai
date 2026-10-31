import { Readable } from 'node:stream';
import type { WorkspaceContentReviewView } from '@cat-cafe/shared';
import type { OpenWorkspaceMediaV1, WorkspaceContentSourceService } from '../../workspace/workspace-content-source.js';
import { WorkspaceContentReviewError } from './errors.js';
import type { EvolutionMediaReadPort, WorkspaceReviewPrincipal } from './workspace-review-types.js';

/** Encoded streams retain their own owner boundary; project JSON never opens through a media endpoint. */
export async function openWorkspaceReviewMedia(
  owners: { source: WorkspaceContentSourceService; evolution?: EvolutionMediaReadPort },
  view: WorkspaceContentReviewView,
  input: { principal: WorkspaceReviewPrincipal; expectedSourceRevision: string },
): Promise<OpenWorkspaceMediaV1 | { mime: string; byteLength: number; stream: Readable }> {
  if (view.review.source.kind === 'video-project') throw new WorkspaceContentReviewError('unsupported_content');
  if (view.sourceState !== 'current' || !view.canWrite) throw new WorkspaceContentReviewError('source_changed');
  if (view.review.source.kind === 'evolution') {
    if (view.review.source.revision !== input.expectedSourceRevision || !owners.evolution)
      throw new WorkspaceContentReviewError('source_changed');
    const original = await owners.evolution.read(view.review.source.locator, input.principal);
    return { mime: original.mime, byteLength: original.bytes.length, stream: Readable.from([original.bytes]) };
  }
  if (view.review.source.kind !== 'media' || view.review.source.revision !== input.expectedSourceRevision)
    throw new WorkspaceContentReviewError('source_changed');
  const media = await owners.source.openMedia({
    principal: { userId: input.principal.userId },
    locator: view.review.source.locator,
    expectedRevision: input.expectedSourceRevision,
  });
  if (media.contentRef !== view.review.contentRef) {
    throw new WorkspaceContentReviewError('source_unavailable');
  }
  return media;
}
