import { commitContentRevision, resolveReplay } from './commit-revision.js';
import { ContentOwnerConflictError, ContentOwnerIdempotencyError, ContentOwnerNotFoundError } from './errors.js';
import { validateActor, validateIdentity, validateRevision } from './input-validation.js';
import { operationFingerprint } from './operation-identity.js';
import { validateVideoProjectMediaScope } from './project-media-scope.js';
import { validateContentOperationContext, validateVideoProjectScope } from './project-scope.js';
import { validateContentPublication } from './publication.js';
import type { ProjectContentOwnerStore, ProjectContentStateV1 } from './store.js';
import { type ContentStream, validateContentStream } from './stream-content.js';
import type { ImportProjectContentInputV1, SettleProjectContentInputV1 } from './types.js';

export type ImportContentStreamInput = Omit<ImportProjectContentInputV1, 'bytes' | 'collectiveScope'> &
  ContentStream & {
    readonly authorizeEffect: () => Promise<void>;
  };
export type SettleContentStreamInput = Omit<SettleProjectContentInputV1, 'bytes'> &
  ContentStream & {
    readonly authorizeEffect: () => Promise<void>;
  };
type StreamMutation = (ImportContentStreamInput & { kind: 'import' }) | (SettleContentStreamInput & { kind: 'settle' });

/** The existing owner manifest, revision and receipt protocol; only the byte transport differs. */
export async function persistContentStream(store: ProjectContentOwnerStore, now: () => string, input: StreamMutation) {
  try {
    validateIdentity(input.contentRef, 'contentRef');
    validateIdentity(input.operationId, 'operationId');
    validateActor(input.actor);
    validateContentStream(input);
    if (input.signal) addAbortSignal(input.signal, input.stream);
    if (typeof input.authorizeEffect !== 'function') throw new TypeError('Stream publication needs current authority');
    if ('collectiveScope' in input) throw new TypeError('Collective stream publication is unsupported');
    if (input.kind === 'settle') {
      validateRevision(input.expectedOwnerRevision);
      if ('projectScope' in input || 'projectMediaScope' in input || 'publicationScope' in input)
        throw new TypeError('Content scope cannot change during settlement');
    }
    return await store.withContentLock(input.contentRef, async () => {
      const state = await store.readState(input.contentRef);
      const metadata = streamMetadata(input, state);
      await input.authorizeEffect();
      const fingerprint = operationFingerprint(metadata);
      const replay = resolveReplay(state, input.operationId, fingerprint);
      if (replay) {
        const revision = state?.revisions.find((item) => item.ownerRevision === replay.ownerRevision);
        if (revision?.byteLength !== input.byteLength)
          throw new ContentOwnerIdempotencyError(input.contentRef, input.operationId);
        return replay;
      }
      const actualOwnerRevision = state?.currentOwnerRevision ?? 0;
      if (actualOwnerRevision !== metadata.expectedOwnerRevision)
        throw new ContentOwnerConflictError(input.contentRef, metadata.expectedOwnerRevision, actualOwnerRevision);
      return commitContentRevision(store, now, {
        ...metadata,
        fingerprint,
        previousState: state,
        bytes: input,
        operationId: input.operationId,
        authorizeEffect: async () => {
          input.signal?.throwIfAborted();
          await input.authorizeEffect();
        },
      });
    });
  } finally {
    input.stream.destroy();
  }
}

function streamScope(input: StreamMutation, state: ProjectContentStateV1 | undefined) {
  if (input.kind === 'import') return input;
  if (!state) throw new ContentOwnerNotFoundError(input.contentRef);
  if (state.projectMediaScope) throw new TypeError('Project screening media is immutable');
  return state;
}

function streamMetadata(input: StreamMutation, state: ProjectContentStateV1 | undefined) {
  const source = streamScope(input, state);
  if ('collectiveScope' in source && source.collectiveScope)
    throw new TypeError('Collective stream publication is unsupported');
  const { mediaType, publicationScope, projectScope, projectMediaScope } = source;
  if (mediaType !== 'video/mp4') throw new TypeError('Stream publication supports MP4 only');
  validateContentPublication(publicationScope, input.sourcePublication);
  validateVideoProjectScope(projectScope, input.contentRef, mediaType, publicationScope);
  validateVideoProjectMediaScope(projectMediaScope, { ...input, mediaType, publicationScope, projectScope });
  validateContentOperationContext(input.operationContext, projectScope);
  return {
    contentRef: input.contentRef,
    expectedOwnerRevision: input.kind === 'import' ? 0 : input.expectedOwnerRevision,
    mediaType,
    blobDigest: input.blobDigest,
    actor: input.actor,
    publicationScope,
    projectScope,
    projectMediaScope,
    operationContext: input.operationContext,
    sourcePublication: input.sourcePublication,
  };
}

import { addAbortSignal } from 'node:stream';
