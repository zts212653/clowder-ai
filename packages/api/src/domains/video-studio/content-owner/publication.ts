import { createHash } from 'node:crypto';
import { mediaPublicationSourceSchema, type WorkspaceMediaSnapshotSource } from '@cat-cafe/shared';
import { evolutionSnapshotPublication } from './published-evolution-media.js';
import {
  type ContentPublicationScopeV1,
  type ContentSourcePublicationV1,
  type EvolutionSnapshotPublicationScopeV1,
  isTaskPublicationScope,
  type WorkspaceSnapshotPublicationScopeV1,
} from './types.js';

export function samePublicationScope(
  left: ContentPublicationScopeV1 | undefined,
  right: ContentPublicationScopeV1,
): boolean {
  if (!left || left.ownerUserId !== right.ownerUserId || left.threadId !== right.threadId) return false;
  if (isTaskPublicationScope(left)) return isTaskPublicationScope(right) && left.taskId === right.taskId;
  if (isTaskPublicationScope(right) || left.kind !== right.kind) return false;
  if (
    (left.kind === 'workspace-snapshot' || left.kind === 'evolution-snapshot') &&
    (right.kind === 'workspace-snapshot' || right.kind === 'evolution-snapshot') &&
    (left.sourceContentRef !== right.sourceContentRef || left.snapshotOperationId !== right.snapshotOperationId)
  )
    return false;
  return (
    JSON.stringify(mediaPublicationSourceSchema.parse(left.source)) ===
    JSON.stringify(mediaPublicationSourceSchema.parse(right.source))
  );
}

export function workspaceSnapshotSourceRef(source: WorkspaceMediaSnapshotSource): string {
  return `workspace:${encodeURIComponent(source.locator.worktreeId)}:${encodeURIComponent(source.locator.path)}`;
}

export function publishedMediaContentRef(
  scope: ContentPublicationScopeV1,
  publication: ContentSourcePublicationV1,
): string {
  return `prepared-media:${createHash('sha256')
    .update(JSON.stringify([scope, publication]))
    .digest('hex')}`;
}

function requirePublicationIdentity(value: unknown, maximum = 2048): void {
  if (typeof value !== 'string' || !value || value.length > maximum || value.trim() !== value || value.includes('\0'))
    throw new TypeError('Invalid content publication identity');
}

function validateSnapshotOrigin(
  scope: WorkspaceSnapshotPublicationScopeV1,
  publication: ContentSourcePublicationV1,
): boolean {
  requirePublicationIdentity(scope.sourceContentRef);
  requirePublicationIdentity(scope.snapshotOperationId, 256);
  if (!scope.sourceContentRef.startsWith('workspace-content:'))
    throw new TypeError('Invalid workspace snapshot identity');
  if (publication.sourceRef !== workspaceSnapshotSourceRef(scope.source)) return false;
  if (
    publication.artifactRef !== scope.sourceContentRef ||
    publication.revision !== scope.source.expectedSourceRevision
  )
    throw new TypeError('Snapshot does not match the authorized workspace version');
  return true;
}

function validateEvolutionOrigin(
  scope: EvolutionSnapshotPublicationScopeV1,
  publication: ContentSourcePublicationV1,
): boolean {
  requirePublicationIdentity(scope.snapshotOperationId, 256);
  const original = evolutionSnapshotPublication(scope.source);
  if (scope.sourceContentRef !== original.artifactRef) throw new TypeError('Invalid evolution snapshot identity');
  if (publication.sourceRef !== original.sourceRef) return false;
  if (publication.artifactRef !== original.artifactRef || publication.revision !== original.revision)
    throw new TypeError('Snapshot does not match the authorized experiment media');
  return true;
}

/** Provenance is supplied only by the publication reader, never from a browser actor claim. */
export function validateContentPublication(
  scope: ContentPublicationScopeV1 | undefined,
  publication: ContentSourcePublicationV1 | undefined,
): void {
  if (!scope && !publication) return;
  if (!scope || !publication) throw new TypeError('Media publication requires both source and authority scope');
  for (const value of [
    scope.ownerUserId,
    scope.threadId,
    publication.artifactRef,
    publication.sourceRef,
    publication.revision,
  ]) {
    requirePublicationIdentity(value);
  }
  if (isTaskPublicationScope(scope)) {
    requirePublicationIdentity(scope.taskId);
    if (publication.threadId && publication.threadId !== scope.threadId)
      throw new TypeError('Task publication thread changed');
  } else {
    const source = mediaPublicationSourceSchema.parse(scope.source);
    if (scope.kind !== source.kind || source.threadId !== scope.threadId)
      throw new TypeError('Invalid publication scope');
    if (scope.kind === 'workspace-snapshot' && validateSnapshotOrigin(scope, publication)) return;
    if (scope.kind === 'evolution-snapshot' && validateEvolutionOrigin(scope, publication)) return;
  }
  if (publication.threadId) requirePublicationIdentity(publication.threadId);
  if (!publication.sourceRef.startsWith(`message:${publication.threadId ?? scope.threadId}:`)) {
    throw new TypeError('Publication source belongs to another thread');
  }
}
