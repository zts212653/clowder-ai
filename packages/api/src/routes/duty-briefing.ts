/**
 * F233 Phase A — 值班简报 route（on-demand 生成 + 绑定管理）
 *
 * GET  /api/duty-briefing/binding   — 查当前绑定
 * PUT  /api/duty-briefing/binding   — 设置/覆盖绑定 thread（INV-1 单 active）
 * POST /api/duty-briefing/generate  — on-demand 呼出简报（degraded 可降级到 fallbackThreadId）
 *
 * 与 daily cron（duty-briefing-cron-spec）共用 generateAndDeliverBriefing 核心。
 * on-demand 与 cron 的唯一区别：on-demand 可带 fallbackThreadId（绑定失效时降级到来源 thread）。
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IBriefingConfigStore } from '../domains/cats/services/duty-briefing/BriefingConfigStore.js';
import { deliverBriefingCard, hasBriefingToday } from '../domains/cats/services/duty-briefing/briefing-delivery.js';
import type { CollectDutyBriefingDeps } from '../domains/cats/services/duty-briefing/collectDutyBriefingInput.js';
import { generateAndDeliverBriefing } from '../domains/cats/services/duty-briefing/generateAndDeliverBriefing.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { requirePrivilegedRouteOwner } from '../utils/privileged-route-guard.js';

export interface DutyBriefingRoutesOptions {
  configStore: IBriefingConfigStore;
  messageStore: Pick<IMessageStore, 'append' | 'getByThread' | 'getByThreadBefore'>;
  threadStore: Pick<IThreadStore, 'get'>;
  collectDeps: Omit<CollectDutyBriefingDeps, 'bindingStatus' | 'now'>;
}

const bindSchema = z.object({ threadId: z.string().min(1) });
const generateSchema = z.object({ fallbackThreadId: z.string().min(1).optional() });

export async function dutyBriefingRoutes(app: FastifyInstance, opts: DutyBriefingRoutesOptions): Promise<void> {
  const { configStore, messageStore, threadStore, collectDeps } = opts;

  app.get('/api/duty-briefing/binding', async (request, reply) => {
    const auth = requirePrivilegedRouteOwner(request, reply, {
      surface: 'Duty briefing binding read',
      ownerErrorMessage: 'Duty briefing binding can only be read by the configured owner',
    });
    if (!auth.ok) return auth.response;
    return { binding: await configStore.getBinding() };
  });

  app.put('/api/duty-briefing/binding', async (request, reply) => {
    const auth = requirePrivilegedRouteOwner(request, reply, {
      surface: 'Duty briefing binding update',
      ownerErrorMessage: 'Duty briefing binding can only be modified by the configured owner',
    });
    if (!auth.ok) return auth.response;

    const parsed = bindSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    // INV-3: 仅写 config，不创建 thread（thread 由 operator 手动建好后绑定）
    await configStore.setBinding(parsed.data.threadId);
    return { binding: await configStore.getBinding() };
  });

  app.post('/api/duty-briefing/generate', async (request, reply) => {
    const auth = requirePrivilegedRouteOwner(request, reply, {
      surface: 'Duty briefing generation',
      ownerErrorMessage: 'Duty briefing generation can only be triggered by the configured owner',
    });
    if (!auth.ok) return auth.response;

    const parsed = generateSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const nowMs = Date.now();
    const result = await generateAndDeliverBriefing({
      collectDeps,
      configStore,
      threadExists: async (tid) => (await threadStore.get(tid)) != null,
      hasBriefingToday: (tid, n) => hasBriefingToday(messageStore, tid, n),
      deliverCard: (tid, card) => deliverBriefingCard(messageStore, tid, card, nowMs),
      fallbackThreadId: parsed.data.fallbackThreadId,
      now: nowMs,
    });
    return { result };
  });
}
