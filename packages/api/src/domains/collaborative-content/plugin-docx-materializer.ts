import { randomUUID } from 'node:crypto';
import { validateDocxMaterializationRequest } from '@clowder-ai/plugin-contract';
import type {
  DocxMaterializationOperation,
  DocxMaterializationRequest,
} from '@clowder-ai/plugin-contract/docx-materialization';
import type { ContentMaterializerPluginRuntime } from '../plugin/content-materializer-runtime/runtime.js';
import { DOCX_MEDIA_TYPE } from './editor-bridge/service.js';
import { EditorSessionError, type PreparedEditorSessionV1 } from './editor-session-service.js';
import type { ContentInspectionPort } from './named-cat-content-service.js';
import { type ContentPatchMaterializerPort, SemanticMaterializationError } from './patch-service.js';

/** Converts authenticated F309 intent to the public compute protocol. Tokens,
 * content references and owner effects stay outside the worker request.
 */
export function createPluginDocxMaterializer(
  runtime: Pick<ContentMaterializerPluginRuntime, 'execute'> | undefined,
): ContentPatchMaterializerPort & ContentInspectionPort {
  const execute = async (
    authority: PreparedEditorSessionV1,
    bytes: Buffer,
    mediaType: string,
    operation: DocxMaterializationOperation,
  ) => {
    if (!runtime || mediaType !== DOCX_MEDIA_TYPE || !authority.executionLeaseDigest)
      throw new EditorSessionError('PROVIDER_UNAVAILABLE', 'Independent DOCX editor unavailable');
    const request: DocxMaterializationRequest = {
      protocolVersion: '1.0.0',
      requestId: randomUUID(),
      mediaType: DOCX_MEDIA_TYPE,
      bytesBase64: bytes.toString('base64'),
      operation,
    };
    if (!validateDocxMaterializationRequest(request)) throw new SemanticMaterializationError('INVALID_REQUEST');
    try {
      const { response } = await runtime.execute(
        {
          installationInstanceId: authority.installationInstanceId,
          providerId: authority.providerId,
          packageDigest: authority.packageDigest,
          providerVersion: authority.providerVersion,
          grantRevision: authority.grantRevision,
          lifecycleRevision: authority.lifecycleRevision,
          executionLeaseDigest: authority.executionLeaseDigest,
        },
        request,
      );
      return response.result;
    } catch {
      throw new EditorSessionError('PROVIDER_UNAVAILABLE', 'Independent DOCX operation failed');
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
