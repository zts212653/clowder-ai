import type { EntrustedWorkOwnerReadV1 } from '@cat-cafe/shared';
import type { EntrustedWorkOwnerReadInput } from '../EntrustedWorkOwnerReadService.js';

export interface PreparedArtifactReadInput {
  readonly artifactRef: string;
  readonly taskThreadId: string;
  readonly taskSubjectRef: string;
  readonly taskOwnerRef: string;
  readonly taskRevision: number;
  readonly ownerUserId: string;
  readonly viewer?: EntrustedWorkOwnerReadInput['viewer'];
}

export interface PreparedArtifactReader {
  /** A transient read scope; never retain it between owner requests or mutations. */
  createReadScope?(): PreparedArtifactReader;
  readPreparedArtifact(
    input: PreparedArtifactReadInput,
  ): Promise<NonNullable<EntrustedWorkOwnerReadV1['preparedArtifact']> | null>;
}
