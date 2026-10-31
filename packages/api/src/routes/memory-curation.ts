import type Database from 'better-sqlite3';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { readCurationPreference, saveCurationPreference } from '../config/user-preferences-curation.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { isDeliveredMessage } from '../domains/cats/services/stores/thread-publication-predicates.js';
import { isSystemUserMessage } from '../domains/cats/services/stores/visibility.js';
import { LUNA_CURATION_PROMPT_VERSION } from '../domains/memory/luna-curation-prompt.js';
import { ensureMemoryOperationsThread, memoryOperationsThreadId } from '../domains/memory/MemoryOperationsThread.js';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { visibleRecallThreads } from './memory-recall-query.js';

interface CurationRoutesOptions {
  projectRoot: string;
  ownerUserId: string;
  db: Database.Database;
  threadStore: IThreadStore;
  messageStore: Pick<IMessageStore, 'getById'>;
  modelLabel: (catId: string) => string;
}

const patch = z.object({ enabled: z.boolean() }).strict();

export const memoryCurationRoutes: FastifyPluginAsync<CurationRoutesOptions> = async (app, opts) => {
  app.addHook('preHandler', async (request, reply) => {
    const user = resolveSessionUserId(request);
    if (!user) return reply.code(401).send({ error: 'Authentication required' });
    if (user !== opts.ownerUserId) return reply.code(403).send({ error: 'Owner required' });
  });
  const preference = () => {
    const value = readCurationPreference(opts.projectRoot);
    return {
      ...value,
      modelLabel: opts.modelLabel(value.curatorCatId),
      systemThreadId: memoryOperationsThreadId(opts.ownerUserId),
    };
  };
  app.get('/api/config/memory-curation', async () => preference());
  app.put('/api/config/memory-curation', async (request, reply) => {
    const parsed = patch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid curation setting' });
    try {
      if (parsed.data.enabled) await ensureMemoryOperationsThread(opts.threadStore, opts.ownerUserId);
      saveCurationPreference(opts.projectRoot, opts.db, parsed.data);
      return preference();
    } catch {
      return reply.code(503).send({ error: 'Curation setting could not be saved' });
    }
  });
  app.get('/api/memory/curation', async (_request, reply) => {
    try {
      const threads = await visibleRecallThreads(opts.ownerUserId, opts.threadStore);
      const rows = opts.db
        .prepare(`SELECT s.id, s.thread_id AS threadId, s.summary, s.model_id AS modelId,
        s.message_count AS messageCount, s.generated_at AS generatedAt FROM summary_segments s
        WHERE prompt_version = ? AND thread_id IN (SELECT value FROM json_each(?))
        AND generated_at >= ? ORDER BY generated_at DESC, id DESC LIMIT 50`)
        .all(
          LUNA_CURATION_PROMPT_VERSION,
          JSON.stringify([...threads.keys()]),
          new Date(Date.now() - 7 * 86_400_000).toISOString(),
        ) as Array<{
        id: string;
        threadId: string;
        summary: string;
        modelId: string;
        messageCount: number;
        generatedAt: string;
      }>;
      const entries = [];
      for (const row of rows) {
        const sources = [
          ...new Set(
            [...row.summary.matchAll(/（来源：([^）]+)）/g)].flatMap((match) =>
              match[1].split('，').map((ref) => ref.split('#')[1]),
            ),
          ),
        ];
        const sourceMessages = await Promise.all(sources.map((id) => opts.messageStore.getById(id)));
        if (
          !sources.length ||
          sourceMessages.some(
            (message) =>
              !message ||
              message.threadId !== row.threadId ||
              (message.userId !== opts.ownerUserId && !isSystemUserMessage(message)) ||
              message.deletedAt ||
              message._tombstone ||
              !isDeliveredMessage(message),
          )
        )
          continue;
        entries.push({ ...row, title: threads.get(row.threadId) });
      }
      return { ...preference(), entries };
    } catch {
      return reply.code(503).send({ error: 'Recent curation unavailable' });
    }
  });
};
