import { SignalArticleStatusSchema, type SignalTier } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadSignalSources, resolveSignalPaths, saveSignalSources } from '../domains/signals/config/sources-loader.js';
import { SignalArticleQueryService } from '../domains/signals/services/article-query-service.js';
import { backfillSourceContent } from '../domains/signals/services/backfill-content.js';
import { runSignalFetchScheduler } from '../domains/signals/services/fetch-scheduler.js';
import { resolveUserId } from '../utils/request-identity.js';

const listInboxQuerySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  source: z.string().min(1).max(200).optional(),
  tier: z.enum(['1', '2', '3', '4']).optional(),
  status: z.enum(['all', 'inbox', 'read', 'starred', 'archived']).optional(),
});

const articleByUrlQuerySchema = z.object({
  url: z.string().url(),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: SignalArticleStatusSchema.optional(),
  source: z.string().min(1).max(200).optional(),
  tier: z.enum(['1', '2', '3', '4']).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

const updateArticleBodySchema = z
  .object({
    status: SignalArticleStatusSchema.optional(),
    tags: z.array(z.string().min(1).max(80)).max(32).optional(),
    summary: z.string().max(4000).optional(),
    note: z.string().max(2000).optional(),
    deletedAt: z.string().optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined ||
      value.tags !== undefined ||
      value.summary !== undefined ||
      value.note !== undefined ||
      value.deletedAt !== undefined,
    'At least one field is required',
  );

const updateSourceBodySchema = z.object({
  enabled: z.boolean(),
});

class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task, task);
    this.tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const signalSourcesUpdateQueue = new SerialTaskQueue();

function requireIdentity(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = resolveUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  return userId;
}

function toSignalTier(value: string | undefined): SignalTier | undefined {
  if (!value) {
    return undefined;
  }
  return Number(value) as SignalTier;
}

export const signalsRoutes: FastifyPluginAsync = async (app) => {
  const paths = resolveSignalPaths();
  const articleQuery = new SignalArticleQueryService({ paths });

  app.get('/api/signals/inbox', async (request, reply) => {
    if (!requireIdentity(request, reply)) {
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = listInboxQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parsed.error.issues };
    }

    const items = await articleQuery.listInbox({
      date: parsed.data.date,
      limit: parsed.data.limit,
      source: parsed.data.source,
      tier: toSignalTier(parsed.data.tier),
      status: parsed.data.status,
    });

    return { items };
  });

  app.get('/api/signals/articles/:id', async (request, reply) => {
    if (!requireIdentity(request, reply)) {
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const params = request.params as { id?: string };
    if (!params.id || params.id.trim().length === 0) {
      reply.status(400);
      return { error: 'Article id is required' };
    }

    const article = await articleQuery.getArticleById(params.id);
    if (!article) {
      reply.status(404);
      return { error: `Article not found: ${params.id}` };
    }

    return { article };
  });

  app.get('/api/signals/articles/by-url', async (request, reply) => {
    if (!requireIdentity(request, reply)) {
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = articleByUrlQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parsed.error.issues };
    }

    const article = await articleQuery.getArticleByUrl(parsed.data.url);
    if (!article) {
      reply.status(404);
      return { error: `Article not found for url: ${parsed.data.url}` };
    }

    return { article };
  });

  app.get('/api/signals/search', async (request, reply) => {
    if (!requireIdentity(request, reply)) {
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const parsed = searchQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid query', details: parsed.error.issues };
    }

    const result = await articleQuery.search({
      query: parsed.data.q,
      limit: parsed.data.limit,
      status: parsed.data.status,
      source: parsed.data.source,
      tier: toSignalTier(parsed.data.tier),
      dateFrom: parsed.data.dateFrom,
      dateTo: parsed.data.dateTo,
    });

    return result;
  });

  app.patch('/api/signals/articles/:id', async (request, reply) => {
    if (!requireIdentity(request, reply)) {
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const params = request.params as { id?: string };
    if (!params.id || params.id.trim().length === 0) {
      reply.status(400);
      return { error: 'Article id is required' };
    }

    const parsed = updateArticleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const article = await articleQuery.updateArticle(params.id, parsed.data);
    if (!article) {
      reply.status(404);
      return { error: `Article not found: ${params.id}` };
    }

    return { article };
  });

  app.get('/api/signals/sources', async (request, reply) => {
    if (!requireIdentity(request, reply)) {
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const config = await loadSignalSources(paths);
    return { sources: config.sources };
  });

  app.patch('/api/signals/sources/:id', async (request, reply) => {
    if (!requireIdentity(request, reply)) {
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const params = request.params as { id?: string };
    if (!params.id || params.id.trim().length === 0) {
      reply.status(400);
      return { error: 'Source id is required' };
    }

    const parsed = updateSourceBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const updated = await signalSourcesUpdateQueue.run(async () => {
      const config = await loadSignalSources(paths);
      const target = config.sources.find((source) => source.id === params.id);
      if (!target) {
        return null;
      }

      const updatedSources = config.sources.map((source) =>
        source.id === params.id
          ? {
              ...source,
              enabled: parsed.data.enabled,
            }
          : source,
      );

      await saveSignalSources(
        {
          ...config,
          sources: updatedSources,
        },
        paths,
      );

      return {
        ...target,
        enabled: parsed.data.enabled,
      };
    });

    if (!updated) {
      reply.status(404);
      return { error: `Source not found: ${params.id}` };
    }

    return {
      source: updated,
    };
  });

  app.post('/api/signals/sources/:id/fetch', async (request, reply) => {
    if (!requireIdentity(request, reply)) {
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const params = request.params as { id?: string };
    if (!params.id || params.id.trim().length === 0) {
      reply.status(400);
      return { error: 'Source id is required' };
    }

    const config = await loadSignalSources(paths);
    const source = config.sources.find((s) => s.id === params.id);
    if (!source) {
      reply.status(404);
      return { error: `Source not found: ${params.id}` };
    }

    const noopEmail = () => ({ sendDailyDigest: async () => ({ status: 'skipped' as const }) });
    const noopInApp = () => ({ publishDailyDigest: async () => ({ status: 'skipped' as const }) });

    const summary = await runSignalFetchScheduler({
      sourceId: params.id,
      paths,
      createEmailService: noopEmail,
      createInAppService: noopInApp,
    });

    if (summary.errors.length > 0 && summary.storedArticles === 0) {
      reply.status(502);
      return { error: 'Fetch failed', summary };
    }

    return { summary };
  });

  app.get('/api/signals/stats', async (request, reply) => {
    if (!requireIdentity(request, reply)) {
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    return articleQuery.getStats();
  });

  app.post('/api/signals/backfill', async (request, reply) => {
    if (!requireIdentity(request, reply)) {
      return { error: 'Identity required (X-Cat-Cafe-User header or userId query)' };
    }

    const body = z.object({ source: z.string().min(1) }).safeParse(request.body);
    if (!body.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: body.error.issues };
    }

    const result = await backfillSourceContent(body.data.source, { paths });
    return { result };
  });
};
