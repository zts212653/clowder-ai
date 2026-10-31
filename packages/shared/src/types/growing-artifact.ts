import { z } from 'zod';

const ref = z.string().trim().min(1).max(1_000);

/** Artifact-owner issued immutable coordinate; callers do not nominate completion snapshots. */
export const preparedArtifactSnapshotV1Schema = z
  .object({
    artifactRef: ref,
    artifactRevision: ref,
    completenessRef: ref,
    previewRef: ref,
    openInWorkspaceRef: ref,
  })
  .strict();
