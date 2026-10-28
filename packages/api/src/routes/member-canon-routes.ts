import { basename, isAbsolute, join, relative } from 'node:path';
import type { AssetCanonRecord } from '@cat-cafe/shared';
import { indexedVersionRefSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MemberCanonService } from '../domains/collaborative-content/asset-canon/member-service.js';
import { AssetCanonConflictError } from '../domains/collaborative-content/asset-canon/store.js';
import type { VideoProjectAssetIndex } from '../domains/video-studio/project/asset-index.js';
import type { WorkspaceContentSourceService } from '../domains/workspace/workspace-content-source.js';
import { listWorktrees } from '../domains/workspace/workspace-security.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';
import { directContentHuman } from './content-modification-routes.js';
import { failAsset, sendAsset } from './work-video-asset-routes.js';

const selection = z
  .object({
    operationId: z.string().min(1).max(200),
    reason: z.string().trim().min(1).max(4000),
    expectedBindingRevision: z.number().int().nonnegative().safe(),
    mode: z.enum(['set', 'clear']),
    indexedVersionRef: indexedVersionRefSchema.optional(),
    expectedAssetRevision: z.number().int().nonnegative().safe().optional(),
  })
  .strict();

export function registerMemberCanonRoutes(
  app: FastifyInstance,
  deps: { members: MemberCanonService; assets: VideoProjectAssetIndex; source: WorkspaceContentSourceService },
) {
  const principal = (request: Parameters<typeof directContentHuman>[0]) => {
    const human = directContentHuman(request);
    return deps.members.requireHuman(human ? { ...human, threadId: '' } : null);
  };
  const fail = (reply: Parameters<typeof failAsset>[0], error: unknown) =>
    error instanceof AssetCanonConflictError
      ? reply.code(409).send({ error: 'asset_conflict', message: error.message })
      : failAsset(reply, error);
  app.get('/api/cats/:catId/canon-avatar', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      const p = principal(request);
      const { catId } = z.object({ catId: z.string().min(1).max(256) }).parse(request.params);
      await deps.members.canon.deps.assertMember(catId, p);
      const { after, historyAfter } = z
        .object({
          after: z.coerce.number().int().nonnegative().safe().default(0),
          historyAfter: z.coerce.number().int().nonnegative().safe().default(0),
        })
        .strict()
        .parse(request.query);
      return {
        ...(await deps.members.project(catId, p)),
        history: await deps.members.history(catId, p, historyAfter),
        ...((deps.members.binding(catId)?.bindingRevision ?? 0) > historyAfter + 50
          ? { nextHistoryAfter: historyAfter + 50 }
          : {}),
        candidates: await deps.members.canon.run(
          { action: 'list-assets', memberAvatarCatId: catId, after, limit: 50 },
          p,
        ),
      };
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/cats/:catId/canon-avatar', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    try {
      const p = principal(request);
      const { catId } = z.object({ catId: z.string().min(1).max(256) }).parse(request.params);
      return await deps.members.select(catId, selection.parse(request.body), p);
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/cats/:catId/canon-avatar/upload', async (request, reply) => {
    try {
      const p = principal(request);
      const { catId } = z.object({ catId: z.string().min(1).max(256) }).parse(request.params);
      const body = selection
        .omit({ mode: true, indexedVersionRef: true, expectedAssetRevision: true })
        .extend({ uploadUrl: z.string().regex(/^\/uploads\/avatar-[0-9]+-[a-f0-9]{8}\.(png|jpg|webp)$/) })
        .strict()
        .parse(request.body);
      await deps.members.canon.deps.assertMember(catId, p);
      const path = join(getDefaultUploadDir(process.env.UPLOAD_DIR), basename(body.uploadUrl));
      const roots = await listWorktrees(process.env.CAT_CAFE_WORKSPACE_ROOT);
      const root = roots.find((r) => {
        const rel = relative(r.root, path);
        return rel && !rel.startsWith('..') && !isAbsolute(rel);
      });
      if (!root) return reply.code(409).send({ error: 'upload_root_not_registered' });
      const locator = await deps.source.resolveFileLocator({
        principal: { userId: p.userId },
        locator: { worktreeId: root.id, path: relative(root.root, path).split('\\').join('/') },
      });
      const inspected = await deps.assets.inspect({
        kind: 'workspace',
        rootId: locator.worktreeId,
        path: locator.path,
      });
      const at = new Date(Number(basename(path).split('-')[1])).toISOString();
      const version: AssetCanonRecord['version'] = {
        id: basename(path),
        mediaType: path.endsWith('.jpg') ? 'image/jpeg' : path.endsWith('.png') ? 'image/png' : 'image/webp',
        ...inspected,
        recordedAt: at,
        origin: { kind: 'created', actor: p.actor, at, refs: [`human-upload:${body.operationId}`] },
      };
      return await deps.members.upload(catId, body, { name: basename(path), version }, p);
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.get('/api/cats/:catId/avatar', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    try {
      const p = principal(request);
      const { catId } = z.object({ catId: z.string().min(1).max(256) }).parse(request.params);
      const { bindingRevision } = z
        .object({ bindingRevision: z.coerce.number().int().positive().optional() })
        .strict()
        .parse(request.query);
      const binding = deps.members.binding(catId);
      if (!binding?.indexedVersionRef) return reply.code(410).send({ error: 'avatar_not_selected' });
      if (bindingRevision !== undefined && bindingRevision !== binding.bindingRevision)
        throw new AssetCanonConflictError('Avatar selection changed');
      const record = deps.members.canon.deps.store.get(p.userId, binding.indexedVersionRef)!;
      await deps.members.canon.access.authorize(record, p);
      const opened = await deps.assets.open(record.version);
      try {
        if (deps.members.binding(catId)?.bindingRevision !== binding.bindingRevision)
          throw new AssetCanonConflictError('Avatar selection changed');
        await deps.members.canon.access.authorize(record, p);
        return await sendAsset(request, reply, opened);
      } catch (error) {
        await opened.handle.close();
        await opened.cleanup();
        throw error;
      }
    } catch (error) {
      return fail(reply, error);
    }
  });
}
