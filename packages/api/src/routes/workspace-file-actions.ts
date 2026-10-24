import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { workspaceReferenceMime } from '../domains/workspace/workspace-file-metadata.js';
import {
  getWorktreeRoot,
  resolveWorkspaceFilesystemPath,
  WorkspaceSecurityError,
} from '../domains/workspace/workspace-security.js';
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
      const resolved = await resolveWorkspaceFilesystemPath(await getWorktreeRoot(worktreeId), path);
      const file = await stat(resolved);
      return file.isFile() || file.isDirectory()
        ? {
            path: resolved,
            mime: file.isDirectory() ? 'inode/directory' : workspaceReferenceMime(resolved),
            byteLength: file.size,
          }
        : { local: false };
    },
    onError: (reply, error) =>
      reply
        .code(error instanceof z.ZodError ? 400 : error instanceof WorkspaceSecurityError ? 403 : 404)
        .send({ error: 'file_action_unavailable' }),
  });
}
