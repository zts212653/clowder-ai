import { catLifeSettingsInputSchema, dreamIdSchema, settlePresentLoopInputSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AutoDreamStore } from '../domains/auto-dream/AutoDreamStore.js';
import { AutoDreamStoreError } from '../domains/auto-dream/AutoDreamStore.js';
import type { CatLifeSettingsService } from '../domains/auto-dream/CatLifeSettingsService.js';
import type { PresentLoopService } from '../domains/auto-dream/PresentLoopService.js';
import {
  type AgentKeyAuthRegistry,
  type CallbackAuthRegistry,
  registerCallbackAuthHook,
  requireCallbackAuth,
  requireCallbackPrincipal,
} from './callback-auth-prehandler.js';

const listQuerySchema = z.object({
  catId: z.string().trim().min(1).max(120).optional(),
  includeArchived: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
const diaryParamsSchema = z.object({ diaryId: dreamIdSchema });
const catLifePreviewBodySchema = z
  .object({
    catId: z.string().trim().min(1).max(120),
    settings: catLifeSettingsInputSchema,
  })
  .strict();

export interface CallbackAutoDreamRouteDependencies {
  registry: CallbackAuthRegistry;
  agentKeyRegistry?: AgentKeyAuthRegistry;
  service: PresentLoopService;
  settingsService: CatLifeSettingsService;
  store: AutoDreamStore;
}

function invalidRequest(reply: FastifyReply, issues: unknown) {
  reply.status(400);
  return { error: 'Invalid request', details: issues };
}

export const callbackAutoDreamRoutes: FastifyPluginAsync<CallbackAutoDreamRouteDependencies> = async (app, opts) => {
  registerCallbackAuthHook(app, opts.registry, { agentKeyRegistry: opts.agentKeyRegistry });

  app.post('/api/callbacks/auto-dream/settle', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = settlePresentLoopInputSchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);

    try {
      return await opts.service.settle(
        {
          kind: 'invocation',
          invocationId: record.invocationId,
          userId: record.userId,
          catId: record.catId,
          threadId: record.threadId,
        },
        parsed.data,
      );
    } catch (error) {
      if (error instanceof AutoDreamStoreError) {
        reply.status(error.statusCode);
        return { error: error.message, code: error.code };
      }
      throw error;
    }
  });

  app.get('/api/callbacks/auto-dream/diaries', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);

    const diaries = await opts.store.listDiaries(principal.userId, parsed.data);
    const metrics = parsed.data.catId ? await opts.store.getMetrics(principal.userId, parsed.data.catId) : null;
    return { diaries, metrics };
  });

  app.get('/api/callbacks/auto-dream/diaries/:diaryId', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const parsed = diaryParamsSchema.safeParse(request.params);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);

    const diary = await opts.store.getDiary(principal.userId, parsed.data.diaryId);
    if (!diary) {
      reply.status(404);
      return { error: 'Diary not found' };
    }
    return { diary, historicalNotice: '这是某天的现场记录未清洗，不代表今天仍成立。' };
  });

  app.post('/api/callbacks/auto-dream/life-settings/preview', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    const parsed = catLifePreviewBodySchema.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error.issues);
    try {
      return await opts.settingsService.preview(principal.userId, parsed.data.catId, parsed.data.settings);
    } catch (error) {
      if (error instanceof AutoDreamStoreError) {
        reply.status(error.statusCode);
        return { error: error.message, code: error.code };
      }
      throw error;
    }
  });
};
