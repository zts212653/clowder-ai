/**
 * Bootcamp Callback Routes
 * POST /api/callbacks/update-bootcamp-state — update bootcamp phase + state
 * POST /api/callbacks/bootcamp-env-check — run env check and store results
 */

import { catIdSchema } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { runEnvironmentCheck } from '../domains/cats/services/bootcamp/env-check.js';
import type { BootcampStateV1, IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { BOOTCAMP_PHASE_ACHIEVEMENTS } from '../domains/leaderboard/achievement-defs.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { deriveCallbackActor, resolveBoundThreadScope } from './callback-scope-helpers.js';

/** Ordered phase list — index determines valid transitions (forward-only) */
const PHASE_ORDER = [
  'phase-0-select-cat',
  'phase-1-intro',
  'phase-2-env-check',
  'phase-3-config-help',
  'phase-3.5-advanced',
  'phase-4-task-select',
  'phase-5-kickoff',
  'phase-6-design',
  'phase-7-dev',
  'phase-8-review',
  'phase-9-complete',
  'phase-10-retro',
  'phase-11-farewell',
] as const;

const PHASE_INDEX = new Map(PHASE_ORDER.map((p, i) => [p, i]));

const bootcampPhaseSchema = z.enum([...PHASE_ORDER]);

const updateBootcampStateCallbackSchema = z.object({
  threadId: z.string().min(1),
  phase: bootcampPhaseSchema.optional(),
  leadCat: catIdSchema().optional(),
  selectedTaskId: z.string().max(50).optional(),
  envCheck: z
    .record(
      z.object({
        ok: z.boolean(),
        version: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .optional(),
  advancedFeatures: z.record(z.enum(['available', 'unavailable', 'skipped'])).optional(),
  completedAt: z.number().optional(),
});

export function registerCallbackBootcampRoutes(
  app: FastifyInstance,
  deps: { registry: InvocationRegistry; threadStore: IThreadStore },
): void {
  const { registry, threadStore } = deps;

  app.post('/api/callbacks/update-bootcamp-state', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = updateBootcampStateCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { threadId, ...updates } = parsed.data;

    // P2: Stale invocation guard — ignore if superseded by newer invocation
    if (!registry.isLatest(actor.invocationId)) {
      return { status: 'stale_ignored' };
    }

    const bound = resolveBoundThreadScope(actor, threadId);
    if (!bound.ok) {
      reply.status(bound.statusCode);
      return { error: bound.error };
    }

    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    // Merge updates into existing bootcampState
    const existing = thread.bootcampState ?? {
      v: 1 as const,
      phase: 'phase-0-select-cat' as const,
      startedAt: Date.now(),
    };

    // P1 fix: Phase transition must be forward-only (no skipping)
    let validTransition = false;
    if (updates.phase !== undefined) {
      const currentPhase = existing.phase as (typeof PHASE_ORDER)[number];
      const currentIdx = PHASE_INDEX.get(currentPhase) ?? 0;
      const targetIdx = PHASE_INDEX.get(updates.phase);
      if (targetIdx === undefined || targetIdx <= currentIdx) {
        reply.status(400);
        return { error: `Invalid phase transition: ${existing.phase} → ${updates.phase} (must advance forward)` };
      }
      // Only allow advancing by 1 step (or to the immediately next phase)
      // Exception: allow skipping phase-3.5-advanced (optional advanced features)
      const gap = targetIdx - currentIdx;
      const skippingAdvanced = existing.phase === 'phase-3-config-help' && updates.phase === 'phase-4-task-select';
      if (gap > 1 && !skippingAdvanced) {
        reply.status(400);
        return { error: `Phase skip not allowed: ${existing.phase} → ${updates.phase} (max 1 step forward)` };
      }
      validTransition = true;
    }

    // Build merged state — spreads preserve existing fields, updates override
    const raw: Record<string, unknown> = { ...existing };
    if (updates.phase !== undefined) raw.phase = updates.phase;
    if (updates.leadCat !== undefined) raw.leadCat = updates.leadCat;
    if (updates.selectedTaskId !== undefined) raw.selectedTaskId = updates.selectedTaskId;
    if (updates.envCheck !== undefined) raw.envCheck = updates.envCheck;
    if (updates.advancedFeatures !== undefined) raw.advancedFeatures = updates.advancedFeatures;
    if (updates.completedAt !== undefined) raw.completedAt = updates.completedAt;

    await threadStore.updateBootcampState(threadId, raw as unknown as BootcampStateV1);

    // Auto-pin thread when bootcamp reaches farewell phase
    if (updates.phase === 'phase-11-farewell') {
      await threadStore.updatePin(threadId, true);
    }

    // F087 Phase D: Emit achievements via F075 event pipeline (P2 fix: unified contract)
    let unlockedAchievement: string | undefined;
    if (validTransition && updates.phase) {
      const achievementId = BOOTCAMP_PHASE_ACHIEVEMENTS.get(updates.phase);
      if (achievementId) {
        const nonce = Math.random().toString(36).slice(2, 10);
        const eventId = `bootcamp:${actor.userId}:achievement_unlocked:${Date.now()}:${nonce}`;
        const eventRes = await app.inject({
          method: 'POST',
          url: '/api/leaderboard/events',
          headers: { 'x-cat-cafe-user': actor.userId },
          payload: {
            eventId,
            source: 'bootcamp',
            catId: actor.catId ?? 'system',
            eventType: 'achievement_unlocked',
            payload: { achievementId },
            timestamp: new Date().toISOString(),
          },
        });
        const eventBody = JSON.parse(eventRes.body) as { status?: string };
        if (eventRes.statusCode === 200 && (eventBody.status === 'ok' || eventBody.status === 'duplicate')) {
          unlockedAchievement = achievementId;
        }
      }
    }

    const updated = await threadStore.get(threadId);
    return {
      bootcampState: updated?.bootcampState,
      ...(unlockedAchievement ? { unlockedAchievement } : {}),
    };
  });

  // POST /api/callbacks/bootcamp-env-check — run env check and auto-store results
  const envCheckCallbackSchema = z.object({
    threadId: z.string().min(1),
  });

  app.post('/api/callbacks/bootcamp-env-check', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const actor = deriveCallbackActor(record);

    const parsed = envCheckCallbackSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { threadId } = parsed.data;

    // P2: Stale invocation guard
    if (!registry.isLatest(actor.invocationId)) {
      return { status: 'stale_ignored' };
    }

    const bound = resolveBoundThreadScope(actor, threadId);
    if (!bound.ok) {
      reply.status(bound.statusCode);
      return { error: bound.error };
    }

    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    const results = await runEnvironmentCheck();

    // Auto-store env check results in bootcampState
    if (thread.bootcampState) {
      const updated = {
        ...thread.bootcampState,
        envCheck: {
          node: results.node,
          pnpm: results.pnpm,
          git: results.git,
          claudeCli: results.claudeCli,
          mcp: results.mcp,
          tts: { ok: results.tts.ok, note: results.tts.recommended },
          asr: results.asr,
          pencil: results.pencil,
        },
      } as unknown as BootcampStateV1;
      await threadStore.updateBootcampState(threadId, updated);
    }

    return results;
  });
}
