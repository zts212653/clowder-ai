import { isContentFileBasename } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveLocalFile } from '../domains/workspace/local-file-source.js';
import { getWorktreeRoot, WorkspaceSecurityError } from '../domains/workspace/workspace-security.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';
import { registerMediaFileActions } from './media-file-actions.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';

function replyFileError(reply: FastifyReply, error: unknown) {
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_media_source' });
  if (error instanceof WorkspaceSecurityError)
    return reply.code(error.code === 'NOT_FOUND' ? 404 : 403).send({ error: 'media_source_unavailable' });
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : null;
  return reply.code(code === 'ENOENT' ? 404 : 500).send({ error: 'media_source_unavailable' });
}
function human(request: FastifyRequest) {
  return workspaceDirectHuman(request, resolveDirectLocalAuthorizationUserId);
}

/** Upload static bytes remain public reads; host actions require the existing direct local human fence. */
export function registerUploadedMediaFileActions(app: FastifyInstance, uploadDir: string) {
  registerMediaFileActions(app, '/api/uploads/:filename', {
    allowDirectoryReveal: true,
    onError: replyFileError,
    authorize: async (request) => {
      if (!human(request)) return null;
      const { filename } = z
        .object({
          filename: z.string().refine(isContentFileBasename),
        })
        .strict()
        .parse(request.params);
      z.object({}).strict().parse(request.query);
      return resolveLocalFile(uploadDir, filename);
    },
  });
}

/** Existing raw-file coordinates do not create a new root grant or accept an OS path from the caller. */
export function registerWorkspaceMediaFileActions(app: FastifyInstance) {
  registerMediaFileActions(app, '/api/workspace/file/raw', {
    allowDirectoryReveal: true,
    onError: replyFileError,
    authorize: async (request) => {
      if (!human(request)) return null;
      const { worktreeId, path } = z
        .object({ worktreeId: z.string().min(1), path: z.string().min(1) })
        .strict()
        .parse(request.query);
      return resolveLocalFile(await getWorktreeRoot(worktreeId), path);
    },
  });
}
