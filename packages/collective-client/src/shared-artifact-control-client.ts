import {
  type CollectiveModificationProjection,
  collectiveArtifactControlSchema,
  collectiveModificationProjectionSchema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { CollectiveClientRequestError } from './client-request.js';
import type { SharedArtifact, SharedArtifactOperation } from './collective-artifact-client.js';

function clearSavedIntent(key: string, serialized: string) {
  if (localStorage.getItem(key) === serialized) localStorage.removeItem(key);
}

function verifyControlReceipt(
  value: unknown,
  artifact: SharedArtifact,
  request: CollectiveModificationProjection,
  action: 'cancel' | 'reject',
) {
  const result = z.object({ request: collectiveModificationProjectionSchema }).parse(value).request;
  if (
    result.requestId !== request.requestId ||
    result.sourceEventId !== artifact.sourceEventId ||
    !['cancelled', 'accepted'].includes(result.state) ||
    (result.state === 'cancelled' && result.resolution?.kind !== (action === 'cancel' ? 'cancelled' : 'rejected'))
  )
    throw new Error('决定回执尚未核对，请重试原操作。');
  return result;
}

export async function resolveSharedArtifactModification(
  operation: SharedArtifactOperation,
  namespace: string,
  artifact: SharedArtifact,
  request: CollectiveModificationProjection,
  action: 'cancel' | 'reject',
) {
  const key = `collective-resolution:${namespace}:${artifact.artifactId}:${request.requestId}:${action}:${action === 'reject' ? request.latestProposalRef : ''}`;
  const saved = localStorage.getItem(key);
  const pending = z
    .object({ operationId: z.string().uuid(), input: collectiveArtifactControlSchema })
    .strict()
    .parse(
      saved
        ? JSON.parse(saved)
        : {
            operationId: crypto.randomUUID(),
            input: {
              requestId: request.requestId,
              expectedRequestRevision: request.revision,
              ...(action === 'reject' ? { proposalRef: request.latestProposalRef } : {}),
            },
          },
    );
  if (
    pending.input.requestId !== request.requestId ||
    (action === 'reject' && pending.input.proposalRef !== request.latestProposalRef)
  )
    throw new Error('决定引用已改变，请重新读取。');
  const serialized = JSON.stringify(pending);
  localStorage.setItem(key, serialized);
  let value: unknown;
  try {
    value = await operation(artifact, action, pending.input, pending.operationId);
  } catch (error) {
    // Committed controls replay before CAS. A definite conflict can release only this failed intent.
    if (error instanceof CollectiveClientRequestError && error.status === 409) clearSavedIntent(key, serialized);
    throw error;
  }
  const result = verifyControlReceipt(value, artifact, request, action);
  clearSavedIntent(key, serialized);
  return result;
}
