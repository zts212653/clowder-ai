import { createHash } from 'node:crypto';
import type {
  ArtifactReviewAnchor,
  WorkspaceContentActor,
  WorkspaceContentAnchor,
  WorkspaceContentSource,
} from '@cat-cafe/shared';
import type {
  WorkspaceContentDescriptionV1,
  WorkspaceMediaDescriptionV1,
} from '../../workspace/workspace-content-source.js';
import { assertMediaAnchor } from '../artifact-review/anchors.js';
import { WorkspaceContentReviewError } from './errors.js';

export function assertWorkspaceReviewHuman(principal: { userId: string; actor: WorkspaceContentActor }): void {
  if (principal.actor.kind !== 'human' || principal.actor.actorId !== principal.userId)
    throw new WorkspaceContentReviewError('access_denied');
}

export function toWorkspaceReviewSource(
  description: WorkspaceContentDescriptionV1 | WorkspaceMediaDescriptionV1,
): WorkspaceContentSource {
  if (description.kind === 'text') {
    return {
      kind: 'text',
      locator: { ...description.locator },
      revision: description.revision,
      mime: description.mime,
      byteLength: description.byteLength,
    };
  }
  if (description.kind === 'media' && 'media' in description) {
    return {
      kind: 'media',
      locator: { ...description.locator },
      revision: description.revision,
      mime: description.mime,
      byteLength: description.byteLength,
      media: description.media,
    };
  }
  throw new WorkspaceContentReviewError('unsupported_content');
}

export function assertWorkspaceMediaAnchor(
  source: Exclude<WorkspaceContentSource, { kind: 'text' }>,
  anchor: ArtifactReviewAnchor,
): void {
  try {
    assertMediaAnchor(anchor, source.media);
  } catch {
    throw new WorkspaceContentReviewError('invalid_action');
  }
}

export function isWorkspaceTextAnchor(
  anchor: WorkspaceContentAnchor,
): anchor is Extract<WorkspaceContentAnchor, { kind: 'text_quote' }> {
  return 'kind' in anchor && anchor.kind === 'text_quote';
}

export function workspaceReviewIdentity(ownerUserId: string, contentRef: string): string {
  return `workspace-review-${createHash('sha256')
    .update(JSON.stringify([ownerUserId, contentRef]))
    .digest('hex')}`;
}

export function workspaceAnnotationId(reviewId: string, operationId: string): string {
  return `workspace-annotation-${createHash('sha256').update(`${reviewId}\u0000${operationId}`).digest('hex')}`;
}

export function validateWorkspaceReviewBody(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 8000)
    throw new WorkspaceContentReviewError('invalid_action');
  return value.trim();
}

export function validateWorkspaceReviewId(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256)
    throw new WorkspaceContentReviewError('invalid_action');
  return value;
}
