/**
 * Summary CRUD Routes (拍立得照片墙)
 *
 * POST   /api/summaries         → 创建纪要 (201)
 * GET    /api/summaries?threadId → 列出线程纪要
 * GET    /api/summaries/:id     → 获取单个 / 404
 * DELETE /api/summaries/:id     → 删除 (204)
 */

import type { CatId, CreateSummaryInput } from '@cat-cafe/shared';
import { catIdSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ISummaryStore } from '../domains/cats/services/stores/ports/SummaryStore.js';
import type { SocketManager } from '../infrastructure/websocket/index.js';

export interface SummariesRoutesOptions {
  summaryStore: ISummaryStore;
  socketManager: SocketManager;
}

const createSchema = z.object({
  threadId: z.string().min(1),
  topic: z.string().min(1).max(200),
  conclusions: z.array(z.string().min(1)).min(1).max(20),
  openQuestions: z.array(z.string().min(1)).max(20).default([]),
  createdBy: z.union([catIdSchema(), z.literal('user')]),
});

export const summariesRoutes: FastifyPluginAsync<SummariesRoutesOptions> = async (app, opts) => {
  const { summaryStore, socketManager } = opts;

  // POST /api/summaries
  app.post('/api/summaries', async (request, reply) => {
    const result = createSchema.safeParse(request.body);
    if (!result.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: result.error.issues };
    }

    const input: CreateSummaryInput = {
      threadId: result.data.threadId,
      topic: result.data.topic,
      conclusions: result.data.conclusions,
      openQuestions: result.data.openQuestions,
      createdBy: result.data.createdBy as CatId | 'user',
    };
    const summary = await summaryStore.create(input);

    // Auto-summary disabled (clowder-ai#343): no longer broadcast to chat flow.
    // Summary is still persisted for memory infrastructure / future Thread Recap.

    reply.status(201);
    return summary;
  });

  // GET /api/summaries?threadId=xxx
  app.get('/api/summaries', async (request, reply) => {
    const { threadId } = request.query as { threadId?: string };
    if (!threadId) {
      reply.status(400);
      return { error: 'Missing threadId query parameter' };
    }

    const summaries = await summaryStore.listByThread(threadId);
    return { summaries };
  });

  // GET /api/summaries/:id
  app.get('/api/summaries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const summary = await summaryStore.get(id);
    if (!summary) {
      reply.status(404);
      return { error: 'Summary not found' };
    }
    return summary;
  });

  // DELETE /api/summaries/:id
  app.delete('/api/summaries/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const deleted = await summaryStore.delete(id);
    if (!deleted) {
      reply.status(404);
      return { error: 'Summary not found' };
    }
    reply.status(204);
  });
};
