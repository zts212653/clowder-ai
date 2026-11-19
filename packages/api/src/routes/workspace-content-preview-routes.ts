import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  WorkspacePreviewSelectionError,
  type WorkspacePreviewService,
} from '../domains/collaborative-content/workspace-preview-service.js';
import { WorkspacePreviewReadError } from '../domains/workspace/workspace-preview-snapshot.js';
import { WorkspaceSecurityError } from '../domains/workspace/workspace-security.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

const previewTarget = z.object({ worktreeId: z.string().min(1).max(256), path: z.string().min(1).max(2048) }).strict();

export function registerWorkspaceContentPreviewRoutes(
  app: FastifyInstance,
  deps: { readonly workspace: Pick<WorkspacePreviewService, 'open'>; readonly ownerUserId: string },
): void {
  app.post('/api/workspace/content-preview', async (request, reply) => {
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (!userId) return reply.status(401).send({ error: { code: 'identity_required' } });
    if (userId !== deps.ownerUserId) return reply.status(403).send({ error: { code: 'content_access_denied' } });
    const body = previewTarget.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: 'invalid_document_target' } });
    try {
      const preview = await deps.workspace.open(body.data);
      reply.header('cache-control', 'no-store');
      return preview ? reply.send(preview) : reply.status(204).send();
    } catch (error) {
      if (error instanceof WorkspacePreviewSelectionError)
        return reply.status(409).send({ error: { code: 'preview_provider_selection_required' } });
      if (error instanceof WorkspacePreviewReadError) {
        return reply.status(error.code === 'preview_file_too_large' ? 413 : 409).send({ error: { code: error.code } });
      }
      if (error instanceof WorkspaceSecurityError)
        return reply.status(error.code === 'NOT_FOUND' ? 404 : 403).send({ error: { code: 'document_unavailable' } });
      request.log.error({ err: error }, 'Workspace content preview could not open');
      return reply.status(500).send({ error: { code: 'document_unavailable' } });
    }
  });
}
