import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveLocalFile } from '../domains/workspace/local-file-source.js';
import { getWorktreeRoot, WorkspaceSecurityError } from '../domains/workspace/workspace-security.js';
import { registerMediaFileActions } from './media-file-actions.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';

/** The same desktop operation as media, now for an explicitly opened registered Workspace file. */
export function registerWorkspaceFileActions(app: FastifyInstance, user: (request: FastifyRequest) => string | null) {
  registerMediaFileActions(app, '/api/workspace/file/actions', {
    allowDirectoryReveal: true,
    authorize: async (request) => {
      if (!workspaceDirectHuman(request, user)) return null;
      const { worktreeId, path } = z
        .object({ worktreeId: z.string().min(1).max(256), path: z.string().min(1).max(2048) })
        .strict()
        .parse(request.query);
      return resolveLocalFile(await getWorktreeRoot(worktreeId), path);
    },
    onError: (reply, error) =>
      reply
        .code(error instanceof z.ZodError ? 400 : error instanceof WorkspaceSecurityError ? 403 : 404)
        .send({ error: 'file_action_unavailable' }),
  });
}
