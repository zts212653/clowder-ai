import type { CatId } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { FastifyPluginAsync } from 'fastify';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { MemoryCueEpisodeStore } from '../domains/memory/cue/MemoryCueEpisodeStore.js';
import { projectInvocationCues } from '../domains/memory/cue/project-invocation-cues.js';
import type { MatterMemoryService } from '../domains/memory/matters/MatterMemoryService.js';
import { resolveHeaderUserId, resolveSessionUserId } from '../utils/request-identity.js';
import { parseCueInvocationBatch, readOwnerCueBatch } from './memory-cue-batch-read.js';
import { cueThreadAccess, readOwnerCueInvocation } from './memory-cue-read-projection.js';
import { memoryInvocationAccess } from './memory-invocation-access.js';
import { withRecallMetricsSignal } from './recall-metrics-request.js';

export interface MemoryCueInvocationReadOptions {
  matterMemoryService?: MatterMemoryService;
  evidenceDb: Database.Database;
  threadStore?: Pick<IThreadStore, 'get' | 'list'>;
  invocationRecordStore?: Pick<IInvocationRecordStore, 'get'>;
  turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
}

/** F321 A1: owner-readable projection over F287's content-free event ledger. */
export const memoryCueInvocationReadRoutes: FastifyPluginAsync<MemoryCueInvocationReadOptions> = async (app, opts) => {
  const episodeStore = new MemoryCueEpisodeStore(opts.evidenceDb);
  app.get<{
    Params: { threadId: string; invocationId: string };
  }>('/api/threads/:threadId/invocations/:invocationId/memory-cues', async (request, reply) => {
    const userId = resolveHeaderUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });

    const { threadId, invocationId } = request.params;
    if (!threadId || !invocationId) {
      return reply.status(400).send({ error: 'threadId and invocationId are required' });
    }
    const threadAccess = await cueThreadAccess(opts, userId, threadId);
    if (threadAccess) return reply.status(threadAccess.status).send({ error: threadAccess.error });
    const result = await readOwnerCueInvocation(
      opts,
      episodeStore,
      userId,
      threadId,
      invocationId,
      resolveSessionUserId(request) !== null,
    );
    if (result.status !== 200) return reply.status(result.status).send({ error: result.error });
    const finalAccess = await cueThreadAccess(opts, userId, threadId);
    if (finalAccess) return reply.status(finalAccess.status).send({ error: finalAccess.error });
    return { threadId, invocationId, cues: result.cues };
  });

  app.get<{ Params: { threadId: string }; Querystring: { invocationIds?: string } }>(
    '/api/threads/:threadId/memory-cues',
    async (request, reply) => {
      const userId = resolveHeaderUserId(request);
      if (!userId) return reply.status(401).send({ error: 'Missing X-Cat-Cafe-User header' });
      const ids = parseCueInvocationBatch(request.query.invocationIds);
      if (!ids) return reply.status(400).send({ error: 'Expected 1–100 invocation IDs within the query budget' });
      const { threadId } = request.params;
      const access = await cueThreadAccess(opts, userId, threadId);
      if (access) return reply.status(access.status).send({ error: access.error });
      try {
        return await withRecallMetricsSignal(request, reply, async (signal) => {
          const invocations = await readOwnerCueBatch(
            opts,
            episodeStore,
            userId,
            threadId,
            ids,
            resolveSessionUserId(request) !== null,
            signal,
          );
          const finalAccess = await cueThreadAccess(opts, userId, threadId);
          if (finalAccess) return reply.status(finalAccess.status).send({ error: finalAccess.error });
          signal.throwIfAborted();
          return { threadId, invocations };
        });
      } catch {
        return reply.status(503).send({ error: 'Cue batch unavailable' });
      }
    },
  );

  app.get<{ Params: { threadId: string; invocationId: string; cueId: string }; Querystring: { catId?: string } }>(
    '/api/threads/:threadId/invocations/:invocationId/memory-cues/:cueId/matter',
    async (request, reply) => {
      const userId = resolveSessionUserId(request);
      if (!userId) return reply.status(401).send({ error: 'Session required' });
      const { threadId, invocationId, cueId } = request.params;
      const thread = await opts.threadStore?.get(threadId);
      const indexed =
        thread?.createdBy === 'system' && (await opts.threadStore?.list(userId))?.some((item) => item.id === threadId);
      if (!thread || thread.deletedAt || (!canAccessThread(thread, userId) && !indexed))
        return reply.status(404).send({ error: 'not_available' });
      const access = await memoryInvocationAccess(opts, userId, threadId, invocationId);
      if (access.status !== 200) return reply.status(access.status).send({ error: access.error });
      const parent = await opts.invocationRecordStore?.get(invocationId);
      const child = parent ? null : await opts.turnExecutionStore?.get(invocationId);
      const cats = parent?.targetCats ?? (child ? [child.catId] : []);
      const catId = request.query.catId;
      if (!catId || !cats.includes(catId as CatId)) return reply.status(404).send({ error: 'not_available' });
      const cue = projectInvocationCues(episodeStore.listByInvocation(userId, threadId, invocationId)).find(
        (entry) => entry.cueId === cueId && entry.consumerCatId === catId && entry.resolverFamily === 'matter',
      );
      if (!cue?.readDetails || !opts.matterMemoryService) return reply.status(404).send({ error: 'not_available' });
      return opts.matterMemoryService.readReceipt(userId, catId as CatId, cue.readDetails, true);
    },
  );
};
