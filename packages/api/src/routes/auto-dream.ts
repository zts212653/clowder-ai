import {
  catLifePreviewDecisionSchema,
  catLifeSettingsInputSchema,
  diaryEngagementInputSchema,
  dreamIdSchema,
  proactiveEchoInputSchema,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  type AutoDreamStore,
  AutoDreamStoreError,
  type DiaryEngagementState,
  type DreamDiaryEntryRecord,
} from '../domains/auto-dream/AutoDreamStore.js';
import type { CatLifeSettingsService } from '../domains/auto-dream/CatLifeSettingsService.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { resolveSessionUserId } from '../utils/request-identity.js';

const BROWSER_SESSION_SENTINEL = 'default-user';

const listQuerySchema = z.object({
  catId: z.string().trim().min(1).max(120).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const diaryParamsSchema = z.object({ diaryId: dreamIdSchema });
const catParamsSchema = z.object({ catId: z.string().trim().min(1).max(120) });
const previewBodySchema = z.object({ settings: catLifeSettingsInputSchema }).strict();
const proactiveEchoListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export interface AutoDreamRouteDependencies {
  store: AutoDreamStore;
  settingsService: CatLifeSettingsService;
  ownerUserId: string;
}

function requireSessionOwner(
  request: FastifyRequest,
  reply: FastifyReply,
  configuredOwnerUserId: string,
): string | null {
  const sessionUserId = resolveSessionUserId(request);
  if (!sessionUserId) {
    reply.status(401).send({ error: 'Authentication required' });
    return null;
  }
  if (sessionUserId !== BROWSER_SESSION_SENTINEL) return sessionUserId;
  if (isDirectLoopbackRequest(request)) return configuredOwnerUserId;

  reply.status(403).send({ error: 'Private auto-dream routes require an authenticated owner session' });
  return null;
}

function invalidRequest(reply: FastifyReply, issues: unknown) {
  reply.status(400);
  return { error: 'Invalid request', details: issues };
}

function handleDomainError(reply: FastifyReply, error: unknown) {
  if (!(error instanceof AutoDreamStoreError)) throw error;
  reply.status(error.statusCode);
  return { error: error.message, code: error.code };
}

function toDiaryPage(diary: DreamDiaryEntryRecord, engagement: DiaryEngagementState) {
  return {
    diaryId: diary.diaryId,
    catId: diary.catId,
    localDate: diary.localDate,
    headline: diary.headline,
    summary: diary.summary,
    engagement,
  };
}

export function registerAutoDreamRoutes(
  app: FastifyInstance,
  { store, settingsService, ownerUserId: configuredOwnerUserId }: AutoDreamRouteDependencies,
): void {
  const normalizedOwnerUserId = configuredOwnerUserId.trim();
  if (!normalizedOwnerUserId) throw new Error('ownerUserId is required for auto-dream routes');

  app.get('/api/auto-dream/diaries', async (request, reply) => {
    const ownerUserId = requireSessionOwner(request, reply, normalizedOwnerUserId);
    if (!ownerUserId) return;
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);

    const diaryRecords = await store.listDiaries(ownerUserId, parsed.data);
    const diaries = await Promise.all(
      diaryRecords.map(async (diary) => toDiaryPage(diary, await store.getDiaryEngagement(ownerUserId, diary.diaryId))),
    );
    const metrics = parsed.data.catId ? await store.getMetrics(ownerUserId, parsed.data.catId) : null;
    const engagementMetrics = parsed.data.catId
      ? await store.getDiaryEngagementMetrics(ownerUserId, parsed.data.catId)
      : null;
    return { diaries, metrics, engagementMetrics };
  });

  app.get('/api/auto-dream/diaries/:diaryId', async (request, reply) => {
    const ownerUserId = requireSessionOwner(request, reply, normalizedOwnerUserId);
    if (!ownerUserId) return;
    const parsed = diaryParamsSchema.safeParse(request.params);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);

    const diary = await store.getDiary(ownerUserId, parsed.data.diaryId);
    if (!diary) {
      reply.status(404);
      return { error: 'Diary not found' };
    }
    const engagement = await store.getDiaryEngagement(ownerUserId, diary.diaryId);
    return {
      diary: { ...toDiaryPage(diary, engagement), bodyMarkdown: diary.bodyMarkdown },
      historicalNotice: '这是某天的现场记录未清洗，不代表今天仍成立。',
    };
  });

  app.post('/api/auto-dream/diaries/:diaryId/engagement', async (request, reply) => {
    const ownerUserId = requireSessionOwner(request, reply, normalizedOwnerUserId);
    if (!ownerUserId) return;
    const params = diaryParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    const body = diaryEngagementInputSchema.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error.issues);
    try {
      return await store.recordDiaryEngagement(ownerUserId, params.data.diaryId, body.data);
    } catch (error) {
      return handleDomainError(reply, error);
    }
  });

  app.get('/api/auto-dream/cats/:catId/life-settings', async (request, reply) => {
    const ownerUserId = requireSessionOwner(request, reply, normalizedOwnerUserId);
    if (!ownerUserId) return;
    const parsed = catParamsSchema.safeParse(request.params);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);
    try {
      const config = await settingsService.getConfig(ownerUserId, parsed.data.catId);
      return {
        catId: parsed.data.catId,
        config,
        defaults: {
          enabled: false,
          rhythm: { kind: 'gentle' },
          wakeTime: '22:00',
          timezone: 'UTC',
        },
      };
    } catch (error) {
      return handleDomainError(reply, error);
    }
  });

  app.post('/api/auto-dream/cats/:catId/life-settings/preview', async (request, reply) => {
    const ownerUserId = requireSessionOwner(request, reply, normalizedOwnerUserId);
    if (!ownerUserId) return;
    const params = catParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    const body = previewBodySchema.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error.issues);
    try {
      return await settingsService.preview(ownerUserId, params.data.catId, body.data.settings);
    } catch (error) {
      return handleDomainError(reply, error);
    }
  });

  app.post('/api/auto-dream/life-settings/decision', async (request, reply) => {
    const ownerUserId = requireSessionOwner(request, reply, normalizedOwnerUserId);
    if (!ownerUserId) return;
    const parsed = catLifePreviewDecisionSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);
    try {
      return await settingsService.decide(ownerUserId, parsed.data.previewId, parsed.data.decision);
    } catch (error) {
      return handleDomainError(reply, error);
    }
  });

  app.get('/api/auto-dream/cats/:catId/status', async (request, reply) => {
    const ownerUserId = requireSessionOwner(request, reply, normalizedOwnerUserId);
    if (!ownerUserId) return;
    const parsed = catParamsSchema.safeParse(request.params);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);

    const [offDuty, metrics] = await Promise.all([
      store.isOffDuty(ownerUserId, parsed.data.catId),
      store.getMetrics(ownerUserId, parsed.data.catId),
    ]);
    return { catId: parsed.data.catId, offDuty, metrics };
  });

  app.get('/api/auto-dream/cats/:catId/proactive-echoes', async (request, reply) => {
    const ownerUserId = requireSessionOwner(request, reply, normalizedOwnerUserId);
    if (!ownerUserId) return;
    const params = catParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    const query = proactiveEchoListQuerySchema.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error.issues);
    return {
      echoes: await store.proactive.listEchoes(ownerUserId, params.data.catId, { limit: query.data.limit }),
    };
  });

  app.post('/api/auto-dream/cats/:catId/proactive-echoes', async (request, reply) => {
    const ownerUserId = requireSessionOwner(request, reply, normalizedOwnerUserId);
    if (!ownerUserId) return;
    const params = catParamsSchema.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error.issues);
    const body = proactiveEchoInputSchema.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error.issues);
    try {
      return await store.proactive.recordEcho(ownerUserId, params.data.catId, body.data);
    } catch (error) {
      return handleDomainError(reply, error);
    }
  });
}
