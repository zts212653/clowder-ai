import type Database from 'better-sqlite3';
import type { FastifyPluginAsync } from 'fastify';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';
import { canAccessThread } from '../domains/guides/guide-state-access.js';
import { MemoryCueEpisodeStore } from '../domains/memory/cue/MemoryCueEpisodeStore.js';
import { projectInvocationCues } from '../domains/memory/cue/project-invocation-cues.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';
import { memoryInvocationAccess } from './memory-invocation-access.js';

export interface MemoryCueInvocationReadOptions {
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
    if (!thread) return reply.status(404).send({ error: 'Thread not found' });
    const isIndexedSystemThread =
      thread.createdBy === 'system' &&
      (await opts.threadStore.list(userId)).some((visibleThread) => visibleThread.id === threadId);
    if (!canAccessThread(thread, userId) && !isIndexedSystemThread) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const access = await memoryInvocationAccess(opts, userId, threadId, invocationId);
    if (access.status !== 200) return reply.status(access.status).send({ error: access.error });

    const events = episodeStore.listByInvocation(userId, threadId, invocationId);
    return { threadId, invocationId, cues: projectInvocationCues(events) };
  });
};
