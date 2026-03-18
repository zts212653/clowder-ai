import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ArtifactJobState, ArtifactKind } from '@cat-cafe/shared';
import { SignalArticleStatusSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveSignalPaths } from '../domains/signals/config/sources-loader.js';
import { SignalArticleQueryService } from '../domains/signals/services/article-query-service.js';
import { readInboxRecords } from '../domains/signals/services/inbox-records.js';
import { StudyMetaService } from '../domains/signals/services/study-meta-service.js';
import { resolveUserId } from '../utils/request-identity.js';

interface TimelineEntry {
  readonly articleId: string;
  readonly articleTitle: string;
  readonly source: string;
  readonly lastStudiedAt: string;
  readonly artifacts: readonly { id: string; kind: ArtifactKind; state: ArtifactJobState; createdAt: string }[];
  readonly threads: readonly { threadId: string; linkedAt: string }[];
}

const linkThreadBodySchema = z.object({
  threadId: z.string().min(1),
});

const batchArticleBodySchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(100),
  action: z.enum(['update', 'delete']),
  fields: z
    .object({
      status: SignalArticleStatusSchema.optional(),
      tags: z.array(z.string().min(1).max(80)).max(32).optional(),
      note: z.string().max(2000).optional(),
    })
    .optional(),
});

export interface StudyRouteOptions {
  threadStore: IThreadStore;
}

export const signalStudyRoutes: FastifyPluginAsync<StudyRouteOptions> = async (app, opts) => {
  const paths = resolveSignalPaths();
  const articleQuery = new SignalArticleQueryService({ paths });
  const studyMeta = new StudyMetaService();

  app.get('/api/signals/articles/:id/study', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return { error: 'Article id is required' };
    }

    const article = await articleQuery.getArticleById(params.id);
    if (!article) {
      reply.status(404);
      return { error: `Article not found: ${params.id}` };
    }

    const meta = await studyMeta.readMeta(params.id, article.filePath);
    return { meta };
  });

  // Phase 9: read note artifact content
  app.get('/api/signals/articles/:id/notes/:noteId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const params = request.params as { id?: string; noteId?: string };
    if (!params.id || !params.noteId) {
      reply.status(400);
      return { error: 'Article id and note id are required' };
    }

    const article = await articleQuery.getArticleById(params.id);
    if (!article) {
      reply.status(404);
      return { error: `Article not found: ${params.id}` };
    }

    const meta = await studyMeta.readMeta(params.id, article.filePath);
    const note = meta.artifacts.find((a) => a.id === params.noteId && a.kind === 'note');
    if (!note?.filePath) {
      reply.status(404);
      return { error: `Note not found: ${params.noteId}` };
    }

    try {
      // Migrated notes store relative paths (e.g. "notes/study_xxx.md");
      // resolve them against the article's sidecar directory.
      const absPath = isAbsolute(note.filePath)
        ? note.filePath
        : join(article.filePath.replace(/\.md$/, ''), note.filePath);
      const content = await readFile(absPath, 'utf-8');
      return { content };
    } catch {
      reply.status(404);
      return { error: 'Note file not found on disk' };
    }
  });

  app.post('/api/signals/articles/:id/threads', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return { error: 'Article id is required' };
    }

    const parsed = linkThreadBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const article = await articleQuery.getArticleById(params.id);
    if (!article) {
      reply.status(404);
      return { error: `Article not found: ${params.id}` };
    }

    const meta = await studyMeta.linkThread(params.id, article.filePath, {
      threadId: parsed.data.threadId,
      linkedBy: userId,
    });

    return { meta };
  });

  // Phase 10: resolve or create a study thread for discussion
  app.post('/api/signals/articles/:id/discuss', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return { error: 'Article id is required' };
    }

    const article = await articleQuery.getArticleById(params.id);
    if (!article) {
      reply.status(404);
      return { error: `Article not found: ${params.id}` };
    }

    const meta = await studyMeta.readMeta(params.id, article.filePath);
    const existingThread = meta.threads.find((t) => !t.stale);
    if (existingThread) {
      return { threadId: existingThread.threadId };
    }

    // No study thread — create one + link (same pattern as resolveStudyThread in podcast routes)
    const thread = await opts.threadStore.create(userId, `Study: ${article.title}`);
    await opts.threadStore.addParticipants(thread.id, ['opus' as never]);
    await studyMeta.linkThread(params.id, article.filePath, {
      threadId: thread.id,
      linkedBy: userId,
    });

    return { threadId: thread.id };
  });

  app.delete('/api/signals/articles/:id/threads/:threadId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const params = request.params as { id?: string; threadId?: string };
    if (!params.id || !params.threadId) {
      reply.status(400);
      return { error: 'Article id and thread id are required' };
    }

    const article = await articleQuery.getArticleById(params.id);
    if (!article) {
      reply.status(404);
      return { error: `Article not found: ${params.id}` };
    }

    const meta = await studyMeta.unlinkThread(params.id, article.filePath, params.threadId);
    return { meta };
  });

  // --- Article DELETE (soft-delete) and batch operations ---

  app.delete('/api/signals/articles/:id', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const params = request.params as { id?: string };
    if (!params.id || params.id.trim().length === 0) {
      reply.status(400);
      return { error: 'Article id is required' };
    }

    const article = await articleQuery.updateArticle(params.id, {
      deletedAt: new Date().toISOString(),
    });
    if (!article) {
      reply.status(404);
      return { error: `Article not found: ${params.id}` };
    }

    return { deleted: true, id: params.id };
  });

  app.post('/api/signals/articles/batch', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const parsed = batchArticleBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { ids, action, fields } = parsed.data;
    let affected = 0;

    for (const id of ids) {
      const input = action === 'delete' ? { deletedAt: new Date().toISOString() } : (fields ?? {});
      const result = await articleQuery.updateArticle(id, input);
      if (result) affected++;
    }

    return { affected, action };
  });

  // AC-19: Study timeline — recent study activity across all articles
  app.get('/api/signals/timeline', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const query = request.query as { days?: string };
    const days = Math.min(Math.max(Number(query.days) || 7, 1), 90);
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();

    const records = await readInboxRecords(paths, undefined);
    const entries: TimelineEntry[] = [];

    for (const record of records) {
      const meta = await studyMeta.readMeta(record.id, record.filePath);
      if (!meta.lastStudiedAt || meta.lastStudiedAt < cutoff) continue;

      const recentArtifacts = meta.artifacts
        .filter((a) => a.createdAt >= cutoff)
        .map((a) => ({ id: a.id, kind: a.kind, state: a.state, createdAt: a.createdAt }));
      const recentThreads = meta.threads
        .filter((t) => !t.stale && t.linkedAt >= cutoff)
        .map((t) => ({ threadId: t.threadId, linkedAt: t.linkedAt }));

      if (recentArtifacts.length === 0 && recentThreads.length === 0) continue;

      entries.push({
        articleId: record.id,
        articleTitle: record.title,
        source: record.source,
        lastStudiedAt: meta.lastStudiedAt,
        artifacts: recentArtifacts,
        threads: recentThreads,
      });
    }

    entries.sort((a, b) => b.lastStudiedAt.localeCompare(a.lastStudiedAt));
    return { entries, days };
  });
};
