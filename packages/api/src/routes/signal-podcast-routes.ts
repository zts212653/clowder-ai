import { readFile } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { AgentRouter } from '../domains/cats/services/agents/routing/AgentRouter.js';
import type { InvocationTracker } from '../domains/cats/services/index.js';
import type { AnyMessageStore } from '../domains/cats/services/stores/factories/MessageStoreFactory.js';
import type { IInvocationRecordStore } from '../domains/cats/services/stores/ports/InvocationRecordStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveSignalPaths } from '../domains/signals/config/sources-loader.js';
import { SignalArticleQueryService } from '../domains/signals/services/article-query-service.js';
import {
  assembleThreadContext,
  generatePodcastScript,
  type ThreadInvokeDeps,
} from '../domains/signals/services/podcast-generator.js';
import { StudyMetaService } from '../domains/signals/services/study-meta-service.js';
import { resolveUserId } from '../utils/request-identity.js';

const podcastBodySchema = z.object({
  mode: z.enum(['essence', 'deep']).default('essence'),
});

export interface PodcastRouteOptions {
  messageStore: AnyMessageStore;
  threadStore: IThreadStore;
  router: AgentRouter;
  invocationRecordStore: IInvocationRecordStore;
  invocationTracker: InvocationTracker;
  queueProcessor: Pick<QueueProcessor, 'markPromptMessagesSeen'>;
}

/**
 * Resolve or create a study thread for the article.
 * AC-P6-1: reuse existing thread; AC-P6-2: create new one.
 */
async function resolveStudyThread(
  studyMeta: StudyMetaService,
  threadStore: IThreadStore,
  articleId: string,
  articleFilePath: string,
  articleTitle: string,
  userId: string,
): Promise<string> {
  const meta = await studyMeta.readMeta(articleId, articleFilePath);
  const existingThread = meta.threads[0];
  if (existingThread) {
    return existingThread.threadId;
  }

  // No study thread — create one + link
  const thread = await threadStore.create(userId, `Study: ${articleTitle}`);
  await threadStore.addParticipants(thread.id, ['opus' as never]);
  await studyMeta.linkThread(articleId, articleFilePath, {
    threadId: thread.id,
    linkedBy: userId,
  });

  return thread.id;
}

export const signalPodcastRoutes: FastifyPluginAsync<PodcastRouteOptions> = async (app, opts) => {
  const paths = resolveSignalPaths();
  const articleQuery = new SignalArticleQueryService({ paths });
  const studyMeta = new StudyMetaService();

  const threadDeps: ThreadInvokeDeps = {
    messageStore: opts.messageStore,
    router: opts.router,
    invocationRecordStore: opts.invocationRecordStore,
    invocationTracker: opts.invocationTracker,
    queueProcessor: opts.queueProcessor,
  };

  app.post('/api/signals/articles/:id/podcast', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const params = request.params as { id?: string };
    if (!params.id) {
      reply.status(400);
      return { error: 'Article id required' };
    }

    const parsed = podcastBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid body', details: parsed.error.issues };
    }

    const article = await articleQuery.getArticleById(params.id);
    if (!article) {
      reply.status(404);
      return { error: `Article not found: ${params.id}` };
    }

    const content = article.content ?? '';
    const threadId = await resolveStudyThread(
      studyMeta,
      opts.threadStore,
      params.id,
      article.filePath,
      article.title,
      userId,
    );

    // P8: Assemble study context (thread messages + notes) for podcast prompt
    const meta = await studyMeta.readMeta(params.id, article.filePath);
    const threadMessages = await opts.messageStore.getByThread(threadId, 50);
    const latestNote = meta.artifacts
      .filter((a) => a.kind === 'note' && a.state === 'ready')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    let noteContent: string | undefined;
    if (latestNote?.filePath) {
      try {
        noteContent = await readFile(latestNote.filePath, 'utf-8');
      } catch {
        /* note file missing — continue without it */
      }
    }
    const threadContext = assembleThreadContext(threadMessages, noteContent);

    const artifact = await generatePodcastScript({
      articleId: params.id,
      articleFilePath: article.filePath,
      articleTitle: article.title,
      articleContent: content,
      mode: parsed.data.mode,
      requestedBy: userId,
      threadId,
      threadDeps,
      threadContext,
    });

    reply.status(202);
    return { artifact };
  });

  // AC-5: Read podcast script for playback
  app.get('/api/signals/articles/:id/podcast/:artifactId', async (request, reply) => {
    const userId = resolveUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }
    const params = request.params as { id?: string; artifactId?: string };
    if (!params.id || !params.artifactId) {
      reply.status(400);
      return { error: 'Missing params' };
    }

    const article = await articleQuery.getArticleById(params.id);
    if (!article) {
      reply.status(404);
      return { error: 'Article not found' };
    }

    const studyData = await studyMeta.readMeta(params.id, article.filePath);
    const artifact = studyData.artifacts.find((a) => a.id === params.artifactId);
    if (!artifact || artifact.kind !== 'podcast') {
      reply.status(404);
      return { error: 'Podcast not found' };
    }
    if (!artifact.filePath) {
      reply.status(404);
      return { error: 'Script not yet generated' };
    }

    try {
      const raw = await readFile(artifact.filePath, 'utf-8');
      const script = JSON.parse(raw) as Record<string, unknown>;
      return { artifact, script };
    } catch {
      reply.status(404);
      return { error: 'Script file not readable' };
    }
  });
};
