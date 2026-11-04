import type { CatId, MatterReadSummary } from '@cat-cafe/shared';
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
import { memoryInvocationAccess } from './memory-invocation-access.js';

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
    if (!opts.threadStore) return reply.status(503).send({ error: 'Thread store unavailable' });
    const thread = await opts.threadStore.get(threadId);
    if (!thread || thread.deletedAt) return reply.status(404).send({ error: 'Thread not found' });
    const isIndexedSystemThread =
      thread.createdBy === 'system' &&
      (await opts.threadStore.list(userId)).some((visibleThread) => visibleThread.id === threadId);
    if (!canAccessThread(thread, userId) && !isIndexedSystemThread) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const access = await memoryInvocationAccess(opts, userId, threadId, invocationId);
    if (access.status !== 200) return reply.status(access.status).send({ error: access.error });

    const events = episodeStore.listByInvocation(userId, threadId, invocationId);
    const parent = await opts.invocationRecordStore?.get(invocationId);
    const child = parent ? null : await opts.turnExecutionStore?.get(invocationId);
    const cats = parent?.targetCats ?? (child ? [child.catId] : []);
    const cues = [];
    for (const cue of projectInvocationCues(events)) {
      if (cue.resolverFamily !== 'matter') {
        cues.push(cue);
        continue;
      }
      // Legacy content-free cue reads retain their operator contract. Matter
      // metadata can reveal original discussion content and requires a session.
      if (!resolveSessionUserId(request) || !cats.includes(cue.consumerCatId as CatId) || !cue.readDetails) continue;
      const read = await opts.matterMemoryService?.readReceipt(
        userId,
        cue.consumerCatId as CatId,
        cue.readDetails,
        true,
      );
      const matterRead: MatterReadSummary =
        read?.status === 'current'
          ? {
              status: 'current',
              matterId: read.page.matter.matterId,
              title: read.page.matter.title,
              messageCount: new Set(
                read.page.entries.map((entry) => `${entry.source.threadId}:${entry.source.messageId}`),
              ).size,
            }
          : read?.status === 'changed'
            ? { status: 'changed', matterId: cue.readDetails.matterId }
            : { status: 'not_available' };
      const { readDetails: _details, ...projection } = cue;
      cues.push({ ...projection, ...(matterRead.status === 'not_available' ? { sourceAnchor: '' } : {}), matterRead });
    }
    return { threadId, invocationId, cues };
  });

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
