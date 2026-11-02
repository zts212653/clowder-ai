import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { resolveLocalFile } from '../domains/workspace/local-file-source.js';
import { getWorktreeRoot, WorkspaceSecurityError } from '../domains/workspace/workspace-security.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';
import { sendWorkspaceFileBytes } from './workspace-file-response.js';

/** Download bytes from the same authorized file, without making arbitrary HTML/scripts an inline API-origin page. */
export function registerWorkspaceFileDownload(app: FastifyInstance, user: (request: FastifyRequest) => string | null) {
  app.get('/api/workspace/file/download', async (request, reply) => {
    if (!workspaceDirectHuman(request, user)) return reply.code(401).send({ error: 'identity_required' });
    const query = z
      .object({ worktreeId: z.string().min(1).max(256), path: z.string().min(1).max(2048) })
      .strict()
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_file_source' });
    try {
      const file = await resolveLocalFile(await getWorktreeRoot(query.data.worktreeId), query.data.path);
      if ('local' in file || file.mime === 'inode/directory') return reply.code(400).send({ error: 'not_a_file' });
      return sendWorkspaceFileBytes(request, reply, file.path, file.byteLength, file.mime, true);
    } catch (error) {
      return reply
        .code(error instanceof WorkspaceSecurityError && error.code !== 'NOT_FOUND' ? 403 : 404)
        .send({ error: 'file_unavailable' });
    }
  });
}
