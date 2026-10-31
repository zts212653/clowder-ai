import { artifactListOriginSchema } from '@/components/artifacts/artifact-list-state';
import { parseArtifactObjectId } from './artifact-object-key';
import { validEvolutionMediaOrigin } from './evolution-media-surface';
import { parseFileCardOrigin } from './file-card-origin';
import type { WorkspaceSurfaceDescriptor } from './workbench-contract';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
}

export function parseFileNavigationOrigin(value: unknown): WorkspaceSurfaceDescriptor['navigationOrigin'] | null {
  const origin = asRecord(value);
  if (origin === null || typeof origin.kind !== 'string') return null;
  if (origin.kind === 'artifact-list') {
    const parsed = artifactListOriginSchema.safeParse(origin);
    return parsed.success ? parsed.data : null;
  }
  if (origin.kind === 'settings' || origin.kind === 'workspace-card') return parseFileCardOrigin(origin);
  if (origin.kind === 'evolution-media') {
    if (
      typeof origin.programId !== 'string' ||
      typeof origin.readingState !== 'string' ||
      typeof origin.expanded !== 'boolean'
    )
      return null;
    const parsed = {
      kind: 'evolution-media' as const,
      programId: origin.programId,
      readingState: origin.readingState,
      expanded: origin.expanded,
    };
    return validEvolutionMediaOrigin(parsed) ? parsed : null;
  }
  if (origin.kind === 'file-tree') {
    if (!isNonEmptyString(origin.worktreeId) || origin.worktreeId.length > 256) return { kind: 'file-tree' };
    return isNonEmptyString(origin.repoRoot) && origin.repoRoot.length <= 4096
      ? { kind: 'file-tree', worktreeId: origin.worktreeId, repoRoot: origin.repoRoot }
      : { kind: 'file-tree', worktreeId: origin.worktreeId };
  }
  if (origin.kind === 'workspace-changes') {
    if (
      !isNonEmptyString(origin.worktreeId) ||
      origin.worktreeId.length > 256 ||
      (origin.threadId !== null && (!isNonEmptyString(origin.threadId) || origin.threadId.length > 256))
    )
      return null;
    return { kind: 'workspace-changes', worktreeId: origin.worktreeId, threadId: origin.threadId };
  }
  if (origin.kind === 'workspace-document') {
    if (
      !isNonEmptyString(origin.worktreeId) ||
      origin.worktreeId.length > 256 ||
      !isNonEmptyString(origin.path) ||
      origin.path.length > 4096 ||
      typeof origin.line !== 'number' ||
      !Number.isSafeInteger(origin.line) ||
      origin.line < 1
    )
      return null;
    return { kind: 'workspace-document', worktreeId: origin.worktreeId, path: origin.path, line: origin.line };
  }
  if (origin.kind === 'workspace-tools-search') {
    // Existing /api/workspace/search limit; this field never truncates the source query.
    if (
      !isNonEmptyString(origin.threadId) ||
      origin.threadId.length > 256 ||
      !isNonEmptyString(origin.query) ||
      origin.query.length > 200 ||
      typeof origin.viewportOffsetPx !== 'number' ||
      !Number.isFinite(origin.viewportOffsetPx)
    )
      return null;
    return {
      kind: 'workspace-tools-search',
      threadId: origin.threadId,
      query: origin.query,
      viewportOffsetPx: origin.viewportOffsetPx,
    };
  }
  if (origin.kind === 'workspace-home-search') {
    if (!isNonEmptyString(origin.query) || origin.query.length > 512) return null;
    if (
      origin.viewportOffsetPx !== undefined &&
      (typeof origin.viewportOffsetPx !== 'number' || !Number.isFinite(origin.viewportOffsetPx))
    )
      return null;
    return {
      kind: 'workspace-home-search',
      query: origin.query,
      ...(origin.viewportOffsetPx !== undefined ? { viewportOffsetPx: origin.viewportOffsetPx } : {}),
    };
  }
  if (origin.kind === 'workspace-home-artifact') {
    if (
      !isNonEmptyString(origin.threadId) ||
      origin.threadId.length > 256 ||
      typeof origin.artifactId !== 'string' ||
      !parseArtifactObjectId(origin.artifactId) ||
      typeof origin.viewportOffsetPx !== 'number' ||
      !Number.isFinite(origin.viewportOffsetPx)
    )
      return null;
    return {
      kind: 'workspace-home-artifact',
      threadId: origin.threadId,
      artifactId: origin.artifactId,
      viewportOffsetPx: origin.viewportOffsetPx,
    };
  }
  if (origin.kind === 'chat-file-link') {
    if (!isNonEmptyString(origin.threadId) || !isNonEmptyString(origin.messageId)) return null;
    return { kind: 'chat-file-link', threadId: origin.threadId, messageId: origin.messageId };
  }
  if (origin.kind === 'meeting-transcript') {
    // C 3480: same-thread meeting-panel origin; invalid threadId fails closed, never degrades into another kind.
    if (!isNonEmptyString(origin.threadId) || origin.threadId.length > 256) return null;
    return { kind: 'meeting-transcript', threadId: origin.threadId };
  }
  return null;
}
