import { stat } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { guessMime } from '../domains/workspace/workspace-file-read.js';
import {
  getWorktreeRoot,
  resolveWorkspaceFilesystemPath,
  WorkspaceSecurityError,
} from '../domains/workspace/workspace-security.js';
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
async function videoFile(root: string, path: string) {
  // Resolve exactly as the original media reader does: registered/confined root,
  // relative location, denylist and full realpath/symlink checks. No body path.
  const resolved = await resolveWorkspaceFilesystemPath(root, path);
  const mime = guessMime(resolved.toLowerCase());
  if (!mime.startsWith('video/')) return { local: false as const };
  const file = await stat(resolved);
  if (!file.isFile()) return { local: false as const };
  return { path: resolved, mime, byteLength: file.size };
}

/** Upload static bytes remain public reads; host actions require the existing direct local human fence. */
export function registerUploadedVideoFileActions(app: FastifyInstance, uploadDir: string) {
  registerMediaFileActions(app, '/api/uploads/:filename', {
    onError: replyFileError,
    authorize: async (request) => {
      if (!human(request)) return null;
      const { filename } = z
        .object({ filename: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(mp4|webm|mov)$/i) })
        .strict()
        .parse(request.params);
      z.object({}).strict().parse(request.query);
      return videoFile(uploadDir, filename);
    },
  });
}

/** Existing raw-file coordinates do not create a new root grant or accept an OS path from the caller. */
export function registerWorkspaceVideoFileActions(app: FastifyInstance) {
  registerMediaFileActions(app, '/api/workspace/file/raw', {
    onError: replyFileError,
    authorize: async (request) => {
      if (!human(request)) return null;
      const { worktreeId, path } = z
        .object({ worktreeId: z.string().min(1), path: z.string().min(1) })
        .strict()
        .parse(request.query);
      return videoFile(await getWorktreeRoot(worktreeId), path);
    },
  });
}
