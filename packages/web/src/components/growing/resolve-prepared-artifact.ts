import type { EntrustedWorkOwnerReadV1, ThreadArtifactDTO } from '@cat-cafe/shared';

export type PreparedArtifactMetadata = ThreadArtifactDTO & { threadId: string; threadTitle?: string };

/** The prepared coordinate names its original thread; do not discover it by scanning all threads. */
export function preparedArtifactThreadId(coordinate: NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']>) {
  const prefix = 'workspace:artifact:';
  const suffix = `:${coordinate.artifactRevision}:${coordinate.artifactRef}`;
  if (!coordinate.openInWorkspaceRef.startsWith(prefix) || !coordinate.openInWorkspaceRef.endsWith(suffix))
    return undefined;
  return coordinate.openInWorkspaceRef.slice(prefix.length, -suffix.length) || undefined;
}

/** Resolve the exact owner publication, never a same-URL sibling or a newer revision. */
export function resolvePreparedArtifact<T extends PreparedArtifactMetadata>(
  artifacts: readonly T[],
  coordinate: NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']>,
): T | undefined {
  const matches = artifacts.filter((artifact) => {
    const ref = artifact.ref ?? artifact.url;
    return (
      ref === coordinate.artifactRef &&
      String(artifact.createdAt) === coordinate.artifactRevision &&
      `workspace:artifact:${artifact.threadId}:${artifact.createdAt}:${ref}` === coordinate.openInWorkspaceRef
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}
