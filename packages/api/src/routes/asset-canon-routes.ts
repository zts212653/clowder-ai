import type { AssetCanonItem } from '@cat-cafe/shared';
import { indexedVersionRefSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AssetCanonService } from '../domains/collaborative-content/asset-canon/service.js';
import { AssetCanonConflictError } from '../domains/collaborative-content/asset-canon/store.js';
import type { VideoProjectAssetIndex } from '../domains/video-studio/project/asset-index.js';
import { directContentHuman } from './content-modification-routes.js';
import { failAsset, sendAsset } from './work-video-asset-routes.js';

export function registerAssetCanonRoutes(
  app: FastifyInstance,
  service: AssetCanonService,
  assets: VideoProjectAssetIndex,
) {
  app.get('/api/asset-canon/:versionRef/bytes', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    const human = directContentHuman(request);
    if (!human) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { versionRef } = z.object({ versionRef: indexedVersionRefSchema }).strict().parse(request.params);
      const query = z
        .object({
          threadId: z.string().max(256).default(''),
          expectedRevision: z.coerce.number().int().nonnegative().optional(),
          purpose: z.enum(['select', 'used']).default('used'),
        })
        .strict()
        .parse(request.query);
      if (query.purpose === 'select' && query.expectedRevision === undefined)
        return reply.code(400).send({ error: 'expected_revision_required' });
      const principal = { ...human, threadId: query.threadId };
      const item = (await service.run(
        {
          action: 'read-asset',
          indexedVersionRef: versionRef,
          ...(query.purpose === 'select' ? { expectedRevision: query.expectedRevision } : {}),
        },
        principal,
      )) as AssetCanonItem;
      const opened = await assets.open(item.record.version);
      try {
        await service.access.authorize(item.record, principal);
        if (
          query.purpose === 'select' &&
          service.deps.store.get(human.userId, versionRef)?.revision !== query.expectedRevision
        )
          throw new AssetCanonConflictError('Canonical selection changed before opening');
        return await sendAsset(request, reply, opened);
      } catch (error) {
        await opened.handle.close();
        await opened.cleanup();
        throw error;
      }
    } catch (error) {
      if (error instanceof AssetCanonConflictError) return reply.code(409).send({ error: 'asset_conflict' });
      return failAsset(reply, error);
    }
  });
}
