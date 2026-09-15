import type { EntrustedWorkOwnerReadV1, GlobalArtifactDTO } from '@cat-cafe/shared';

/** Resolve the exact owner publication, never a same-URL sibling or a newer revision. */
export function resolvePreparedArtifact(
  artifacts: readonly GlobalArtifactDTO[],
  coordinate: NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']>,
): GlobalArtifactDTO | undefined {
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
