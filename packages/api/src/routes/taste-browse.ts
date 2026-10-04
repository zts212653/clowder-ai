import type { FastifyPluginAsync } from 'fastify';
import type { TasteObservatorySnapshot } from '../domains/memory/taste/TasteObservatoryReader.js';
import type { TasteRepository } from '../domains/taste/services/TasteRepository.js';
import { resolveDirectLocalAuthorizationUserId, resolveSessionUserId } from '../utils/request-identity.js';
import { projectTasteContext, readTasteApproval } from './taste-browse-context.js';
import { projectTasteMemory, projectTasteRecall, tasteMemoryId, visibleTasteMemories } from './taste-browse-model.js';
import { readTasteSource, type TasteSourceReaders } from './taste-browse-source.js';

export interface TasteBrowseOptions extends TasteSourceReaders {
  ownerUserId: string;
  tasteRepository: TasteRepository;
  readObservatory: (owner: string, includePrivate: boolean) => Promise<TasteObservatorySnapshot>;
}
type BoundMemory = { Params: { memoryId: string }; Querystring: { revision?: string } };

/** Additive browser-owner reads; no proposal/writer authority is granted here. */
export const tasteBrowseRoutes: FastifyPluginAsync<TasteBrowseOptions> = async (app, opts) => {
  app.addHook('preHandler', async (request, reply) => {
    const user = resolveSessionUserId(request);
    if (!user) return reply.code(401).send({ error: 'Session required' });
    if (user !== opts.ownerUserId) return reply.code(403).send({ error: 'Owner required' });
  });
  app.get('/api/memory/taste', async (request, reply) => {
    try {
      const privateAccess = resolveDirectLocalAuthorizationUserId(request) === opts.ownerUserId;
      const memories = await visibleTasteMemories(opts.tasteRepository, opts.ownerUserId, privateAccess);
      let stats: TasteObservatorySnapshot | null = null;
      try {
        stats = await opts.readObservatory(opts.ownerUserId, privateAccess);
      } catch {
        /* Independent projection stays partial. */
      }
      const byPath = new Map(stats?.entries.map((entry) => [entry.sourcePath, entry]));
      const titles = new Map<string, Promise<{ title: string | null; threadId?: string }>>();
      return {
        readStatus: stats ? 'ready' : 'partial',
        entries: await Promise.all(
          memories.map(async (memory) => ({
            ...projectTasteMemory(memory, null),
            approval: await readTasteApproval(memory, opts.ownerUserId, opts),
            recall: await projectTasteContext(
              projectTasteRecall(byPath.get(memory.sourcePath)),
              opts.ownerUserId,
              opts,
              titles,
            ),
          })),
        ),
        coverage: stats ? { unverified: stats.coverage.totalUnverified } : null,
      };
    } catch {
      return reply.code(503).send({ error: 'Taste source unavailable' });
    }
  });
  for (const source of [false, true]) {
    app.get<BoundMemory>(`/api/memory/taste/:memoryId${source ? '/source' : ''}`, async (request, reply) => {
      if (!/^taste-[0-9a-f]{24}$/.test(request.params.memoryId)) return reply.code(404).send({ error: 'Unavailable' });
      if (!/^sha256:[0-9a-f]{64}$/.test(request.query.revision ?? ''))
        return reply.code(400).send({ error: 'Revision required' });
      try {
        const memories = await visibleTasteMemories(
          opts.tasteRepository,
          opts.ownerUserId,
          resolveDirectLocalAuthorizationUserId(request) === opts.ownerUserId,
        );
        const memory = memories.find((item) => tasteMemoryId(item.sourcePath) === request.params.memoryId);
        if (!memory) return reply.code(404).send({ error: 'Unavailable' });
        if (memory.revision !== request.query.revision) return reply.code(409).send({ error: 'Revision changed' });
        if (source) return await readTasteSource(memory, opts.ownerUserId, opts);
        return {
          ...projectTasteMemory(memory, null),
          approval: await readTasteApproval(memory, opts.ownerUserId, opts),
        };
      } catch {
        return reply.code(503).send({ error: 'Taste source unavailable' });
      }
    });
  }
};
