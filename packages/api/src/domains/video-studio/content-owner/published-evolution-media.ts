import { createHash } from 'node:crypto';
import type { EvolutionMediaSnapshotSource } from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from '../../collaborative-content/workspace-review/errors.js';
import {
  type EvolutionMediaReadPort,
  evolutionContentRef,
} from '../../collaborative-content/workspace-review/evolution-review-source.js';
import { normalizeEvolutionSnapshot } from './evolution-snapshot-media.js';
import { MediaOwnerError } from './media-errors.js';
import type { MediaReviewPrincipal } from './published-media-access.js';
import type { EvolutionSnapshotPublicationScopeV1 } from './types.js';

export function evolutionSnapshotPublication(source: EvolutionMediaSnapshotSource) {
  const contentRef = evolutionContentRef(source.locator);
  return { artifactRef: contentRef, sourceRef: contentRef, revision: 'sha256:' + source.locator.mediaRef.version };
}

export async function readEvolutionSnapshotSource(
  port: EvolutionMediaReadPort | undefined,
  source: EvolutionMediaSnapshotSource,
  principal: MediaReviewPrincipal,
) {
  if (!port) throw new MediaOwnerError('media_unavailable');
  try {
    const result = await port.read(source.locator, principal);
    if (createHash('sha256').update(result.bytes).digest('hex') !== source.locator.mediaRef.version)
      throw new MediaOwnerError('publication_changed');
    return result;
  } catch (error) {
    if (error instanceof WorkspaceContentReviewError)
      throw new MediaOwnerError(error.code === 'access_denied' ? 'access_denied' : 'media_unavailable');
    throw error;
  }
}

export async function resolveEvolutionSnapshot(
  port: EvolutionMediaReadPort | undefined,
  source: EvolutionMediaSnapshotSource,
  operationId: string,
  principal: MediaReviewPrincipal,
) {
  if (principal.actor.kind !== 'human') throw new MediaOwnerError('access_denied');
  await readEvolutionSnapshotSource(port, source, principal);
  const scope: EvolutionSnapshotPublicationScopeV1 = {
    kind: 'evolution-snapshot',
    ownerUserId: principal.userId,
    threadId: source.threadId,
    source,
    sourceContentRef: evolutionContentRef(source.locator),
    snapshotOperationId: operationId,
  };
  return {
    scope,
    publication: evolutionSnapshotPublication(source),
    load: async () => {
      const read = await readEvolutionSnapshotSource(port, source, principal);
      const result = await normalizeEvolutionSnapshot(read.bytes, read.mime, read.media);
      await readEvolutionSnapshotSource(port, source, principal);
      return result;
    },
  };
}
