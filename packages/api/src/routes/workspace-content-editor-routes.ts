import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EditorSessionError } from '../domains/collaborative-content/editor-session-service.js';
import {
  type WorkspaceEditorService,
  WorkspaceEditorUnavailableError,
} from '../domains/collaborative-content/workspace-editor-service.js';
import { WorkspaceSecurityError } from '../domains/workspace/workspace-security.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

export function registerWorkspaceContentEditorRoutes(
  app: FastifyInstance,
  deps: {
    readonly workspace: Pick<WorkspaceEditorService, 'open'>;
    readonly ownerUserId: string;
  },
): void {
  app.post('/api/workspace/content-editor', async (request, reply) => {
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (!userId) return reply.status(401).send({ error: { code: 'identity_required' } });
    if (userId !== deps.ownerUserId) return reply.status(403).send({ error: { code: 'content_access_denied' } });
    const body = z
      .object({ worktreeId: z.string().min(1).max(256), path: z.string().min(1).max(2048) })
      .strict()
      .safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: 'invalid_document_target' } });
    try {
      return reply.send(await deps.workspace.open({ ...body.data, principal: { kind: 'human', subjectId: userId } }));
    } catch (error) {
      if (error instanceof WorkspaceEditorUnavailableError || error instanceof EditorSessionError) {
        return reply.status(409).send({ error: { code: error.code.toLowerCase() } });
      }
      if (error instanceof WorkspaceSecurityError) {
        return reply.status(error.code === 'NOT_FOUND' ? 404 : 403).send({ error: { code: 'document_unavailable' } });
      }
      request.log.error({ err: error }, 'Workspace content editor could not open');
      return reply.status(500).send({ error: { code: 'document_unavailable' } });
    }
  });
}
