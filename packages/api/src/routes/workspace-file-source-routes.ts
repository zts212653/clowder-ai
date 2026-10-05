import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prepareAbsoluteFileDirectory } from '../domains/workspace/workspace-absolute-file-source.js';
import { WorkspaceContentSourceError } from '../domains/workspace/workspace-content-source.js';
import {
  createWorkspaceContentSource,
  resolveWorkspaceContentRoot,
} from '../domains/workspace/workspace-content-source-factory.js';
import { readWorkspaceFileLocations } from '../domains/workspace/workspace-file-locations.js';
import { resolveWorkspaceAbsolutePath } from '../domains/workspace/workspace-path-resolution.js';
import {
  getWorktreeRoot,
  resolveWorkspaceFilesystemPath,
  WorkspaceSecurityError,
} from '../domains/workspace/workspace-security.js';
import {
  resolveSelectedWorkspaceFile,
  WorkspaceLocationInventoryUnavailable,
} from '../domains/workspace/workspace-selected-file.js';
import { workspaceDirectHuman } from './workspace-direct-human.js';

/** Navigation only: the destination's file/Office/content owner still authorizes every operation. */
export function registerWorkspaceFileSourceRoutes(
  app: FastifyInstance,
  resolveUserId: (request: FastifyRequest) => string | null,
): void {
  const user = (request: FastifyRequest) => workspaceDirectHuman(request, resolveUserId);
  app.get('/api/workspace/file-locations', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const ownerUserId = user(request);
    if (!ownerUserId) return reply.code(401).send({ error: { code: 'identity_required' } });
    try {
      return { ownerUserId, ...(await readWorkspaceFileLocations()) };
    } catch {
      return reply.code(503).send({ error: { code: 'source_resolution_unavailable' } });
    }
  });
  app.post('/api/workspace/resolve-file-source', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const ownerUserId = user(request);
    if (!ownerUserId) return reply.code(401).send({ error: { code: 'identity_required' } });
    const body = z
      .object({
        path: z.string().min(1).max(4096),
        root: z.string().min(1).max(4096).optional(),
        worktreeId: z.string().min(1).max(256).optional(),
        selectedRoot: z.string().min(1).max(4096).optional(),
        selectionEpoch: z.number().int().nonnegative().optional(),
        expectedUserId: z.string().min(1).max(256).optional(),
      })
      .strict()
      .safeParse(request.body);
    if (
      !body.success ||
      body.data.path.includes('\0') ||
      (body.data.root && body.data.worktreeId) ||
      (body.data.selectedRoot && (body.data.root || body.data.selectedRoot.includes('\0'))) ||
      (!body.data.root && !body.data.worktreeId && !body.data.selectedRoot && !isAbsolute(body.data.path))
    )
      return reply.code(400).send({ error: { code: 'absolute_file_path_required' } });
    if (body.data.expectedUserId && body.data.expectedUserId !== ownerUserId)
      return reply.code(409).send({ error: { code: 'identity_changed' } });
    try {
      if (body.data.selectedRoot)
        return await resolveSelectedWorkspaceFile(
          ownerUserId,
          body.data.selectedRoot,
          body.data.path,
          body.data.selectionEpoch,
        );
      if (!body.data.root && !body.data.worktreeId) {
        const prepared = await prepareAbsoluteFileDirectory(ownerUserId, body.data.path);
        if (prepared) return prepared;
      }
      let absolutePath = body.data.path;
      if (body.data.worktreeId)
        absolutePath = await resolveWorkspaceFilesystemPath(
          (await resolveWorkspaceContentRoot(body.data.worktreeId)).root,
          body.data.path,
        );
      if (body.data.root) {
        const requestedRoot = await realpath(body.data.root).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT')
            throw new WorkspaceSecurityError('Selected location is unavailable', 'NOT_FOUND');
          throw error;
        });
        const selected = (await readWorkspaceFileLocations()).locations.find((entry) => entry.root === requestedRoot);
        if (!selected) throw new WorkspaceSecurityError('Selected location is unavailable', 'NOT_FOUND');
        if (selected.status !== 'available')
          throw new WorkspaceSecurityError('Selected location cannot be verified', 'DENIED');
        absolutePath = await resolveWorkspaceFilesystemPath(selected.root, body.data.path);
      }
      const target = await resolveWorkspaceAbsolutePath(absolutePath);
      if (target.kind !== 'file') return reply.code(400).send({ error: { code: 'file_required' } });
      // A reused UI alias must not redirect the native file reader to another registered root.
      const readerPath = join(await getWorktreeRoot(target.worktreeId), target.path);
      if ((await realpath(readerPath)) !== (await realpath(absolutePath)))
        throw new WorkspaceSecurityError('Workspace alias no longer identifies this file', 'DENIED');
      const contentRoot = await resolveWorkspaceContentRoot(target.worktreeId);
      if ((await realpath(join(contentRoot.root, target.path))) !== (await realpath(absolutePath)))
        throw new WorkspaceSecurityError('Content owner does not identify the selected file', 'DENIED');
      const source = await createWorkspaceContentSource(ownerUserId).describe({
        principal: { userId: ownerUserId },
        locator: { worktreeId: contentRoot.canonicalWorktreeId, path: target.path },
      });
      return {
        ...source.locator,
        kind: 'file',
        ...(body.data.root ? { absolutePath: await realpath(absolutePath) } : {}),
      };
    } catch (error) {
      if (error instanceof WorkspaceLocationInventoryUnavailable)
        return reply.code(409).send({ error: { code: 'directory_inventory_unavailable', locations: error.locations } });
      if (error instanceof WorkspaceContentSourceError)
        return reply
          .code(
            error.code === 'not_found'
              ? 404
              : error.code === 'too_large'
                ? 413
                : error.code === 'revision_changed'
                  ? 409
                  : 403,
          )
          .send({ error: { code: error.code } });
      if (error instanceof WorkspaceSecurityError)
        return reply
          .code(error.code === 'NOT_FOUND' ? 404 : 403)
          .send({ error: { code: error.code === 'NOT_FOUND' ? 'not_found' : 'access_denied' } });
      return reply.code(503).send({ error: { code: 'source_resolution_unavailable' } });
    }
  });
}
