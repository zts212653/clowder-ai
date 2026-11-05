import { randomUUID } from 'node:crypto';
import type { ContentEditorSemanticWorker } from '../plugin/content-editor-runtime/semantic-worker.js';
import {
  type EditorWorkerRequest,
  editorWorkerRequest,
} from '../plugin/content-editor-runtime/semantic-worker-protocol.js';
import { EditorSessionError, type PreparedEditorSessionV1 } from './editor-session-service.js';
import type { ContentInspectionPort } from './named-cat-content-service.js';
import { type ContentPatchMaterializerPort, SemanticMaterializationError } from './patch-service.js';

/** Converts authenticated F309 intent to the existing editor worker wire. Tokens,
 * content references and owner effects stay outside the worker request.
 */
export function createPluginEditorWorker(
  runtime: Pick<ContentEditorSemanticWorker, 'execute'> | undefined,
): ContentPatchMaterializerPort & ContentInspectionPort {
  const execute = async (
    authority: PreparedEditorSessionV1,
    bytes: Buffer,
    mediaType: string,
    operation: EditorWorkerRequest['operation'],
  ) => {
    if (!runtime || !authority.executionLeaseDigest)
      throw new EditorSessionError('PROVIDER_UNAVAILABLE', 'Independent editor unavailable');
    const request: EditorWorkerRequest = {
      protocolVersion: '1.0.0',
      requestId: randomUUID(),
      mediaType,
      bytesBase64: bytes.toString('base64'),
      operation,
    };
    if (!editorWorkerRequest.safeParse(request).success) throw new SemanticMaterializationError('INVALID_REQUEST');
    try {
      const { response } = await runtime.execute(
        {
          installationInstanceId: authority.installationInstanceId,
          providerId: authority.providerId,
          packageDigest: authority.packageDigest,
          providerVersion: authority.providerVersion,
          lifecycleRevision: authority.lifecycleRevision,
          executionLeaseDigest: authority.executionLeaseDigest,
        },
        request,
      );
      return response.result;
    } catch {
      throw new EditorSessionError('PROVIDER_UNAVAILABLE', 'Independent editor operation failed');
    }
  };
  return {
    async inspect(input) {
      const result = await execute(input.authority, input.bytes, input.mediaType, {
        kind: 'inspect',
        cursor: input.cursor,
        limit: input.limit,
      });
      if (result.kind === 'rejected') throw new SemanticMaterializationError(result.code);
      if (result.kind !== 'inspection')
        throw new EditorSessionError('PROVIDER_UNAVAILABLE', 'Invalid inspection result');
      return result;
    },
    async materialize(input) {
      const result = await execute(input.authority, input.bytes, input.mediaType, {
        ...input.operation,
        attribution: input.attribution,
      });
      if (result.kind === 'rejected') throw new SemanticMaterializationError(result.code);
      if (result.kind !== 'document') throw new EditorSessionError('PROVIDER_UNAVAILABLE', 'Invalid document result');
      return Buffer.from(result.bytesBase64, 'base64');
    },
  };
}
