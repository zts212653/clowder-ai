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
    onError: (reply, error) => {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_file_source' });
      if (error instanceof WorkspaceSecurityError && error.code !== 'NOT_FOUND')
        return reply.code(403).send({ error: 'access_denied' });
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EACCES' || code === 'EPERM') return reply.code(403).send({ error: 'access_denied' });
      if (code === 'NOT_FOUND' || code === 'ENOENT' || code === 'ENOTDIR')
        return reply.code(404).send({ error: 'not_found' });
      return reply.code(500).send({ error: 'file_action_failed' });
    },
  });
}
