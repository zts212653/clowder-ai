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
import type { SocketManager } from '../infrastructure/websocket/index.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { deriveCallbackActor, resolveBoundThreadScope } from './callback-scope-helpers.js';

/**
 * Ordered phase list — index determines valid transitions (forward-only).
 * Wizard creates thread at phase-1-intro directly (Phase 0 handled by UI).
 *
 * F171 v2 flow: first cat develops solo (phases 4-7) → add teammate (7.5) →
 * collaboration (8) → project complete (9) → farewell guidance (10-11).
 */
const PHASE_ORDER = [
  'phase-1-intro',
  'phase-2-env-check',
  'phase-3-config-help',
  'phase-4-task-select',
  'phase-5-kickoff',
  'phase-6-design',
  'phase-7-dev',
  'phase-7.5-add-teammate',
  'phase-8-collab',
  'phase-9-complete',
  'phase-10-retro',
  'phase-11-farewell',
] as const;

const PHASE_INDEX = new Map(PHASE_ORDER.map((p, i) => [p, i]));

/**
 * Allowed legacy skip pairs: "currentPhase→normalizedTarget".
 * Legacy phase names map to phases multiple steps ahead in the new flow.
 * Only specific source→target combinations are valid — prevents arbitrary
 * phase skipping by sending a legacy name from an early phase.
 */
const ALLOWED_LEGACY_SKIPS: ReadonlySet<string> = new Set([
  // phase-4-first-project → phase-7-dev: old flow came after config/task phases
  'phase-3-config-help→phase-7-dev',
  'phase-4-task-select→phase-7-dev',
  'phase-5-kickoff→phase-7-dev',
  'phase-6-design→phase-7-dev',
  // phase-3.5-advanced → phase-3-config-help: old flow came after intro/env-check
  'phase-1-intro→phase-3-config-help',
  'phase-2-env-check→phase-3-config-help',
]);

/** Map legacy phase names (pre-F171-v2) to their nearest current equivalent. */
const LEGACY_PHASE_MAP: Record<string, (typeof PHASE_ORDER)[number]> = {
  'phase-0-select-cat': 'phase-1-intro',
  'phase-3.5-advanced': 'phase-3-config-help',
  'phase-4-first-project': 'phase-7-dev',
  'phase-4.5-add-teammate': 'phase-7.5-add-teammate',
  'phase-8-review': 'phase-8-collab',
};

const bootcampPhaseSchema = z.enum([
  ...PHASE_ORDER,
  ...(Object.keys(LEGACY_PHASE_MAP) as (typeof PHASE_ORDER)[number][]),
]);

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
  /** F171: sub-step for bootcamp guide overlay */
  guideStep: z
    .enum([
      'open-hub',
      'click-add-member',
      'fill-form',
      'done',
      'return-to-chat',
      'mention-teammate',
      'farewell-new-thread',
      'farewell-bootcamp',
      'farewell-input-tips',
    ])
    .nullable()
    .optional(),
  completedAt: z.number().optional(),
});

export function registerCallbackBootcampRoutes(
  app: FastifyInstance,
  deps: { registry: InvocationRegistry; threadStore: IThreadStore; socketManager: SocketManager },
): void {
  const { registry, threadStore, socketManager } = deps;

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

    // Normalize legacy phase names before any downstream logic (PHASE_INDEX lookup,
    // persistence, achievements). Without this, legacy names pass schema validation
    // but get rejected by the forward-only transition check or persist stale names.
    // Track whether normalization occurred — legacy-originated transitions inherently
    // span multiple phases (e.g. phase-4-first-project → phase-7-dev) so the gap
    // check must be relaxed while still enforcing forward-only.
    let phaseWasLegacy = false;
    if (updates.phase && updates.phase in LEGACY_PHASE_MAP) {
      phaseWasLegacy = true;
      updates.phase = LEGACY_PHASE_MAP[updates.phase];
    }

    // P2: Stale invocation guard — ignore if superseded by newer invocation
    if (!(await registry.isLatest(actor.invocationId))) {
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
      phase: 'phase-1-intro' as const,
      startedAt: Date.now(),
    };

    // P1 fix: Phase transition must be forward-only (no skipping)
    let validTransition = false;
    if (updates.phase !== undefined) {
      const rawPhase = existing.phase as string;
      const currentPhase = (LEGACY_PHASE_MAP[rawPhase] ?? rawPhase) as (typeof PHASE_ORDER)[number];
      const currentIdx = PHASE_INDEX.get(currentPhase);
      const targetIdx = PHASE_INDEX.get(updates.phase);
      if (currentIdx === undefined) {
        // Unmapped legacy phase — allow any forward transition (don't block users on upgrade)
        request.log.warn(
          { threadId, rawPhase, targetPhase: updates.phase },
          '[bootcamp] unmapped legacy phase — allowing transition',
        );
        validTransition = true;
      } else {
        request.log.info(
          { threadId, currentPhase, targetPhase: updates.phase, currentIdx, targetIdx, catId: record.catId },
          '[bootcamp] phase transition attempt',
        );
        if (targetIdx === undefined || targetIdx <= currentIdx) {
          request.log.warn(
            { threadId, currentPhase, targetPhase: updates.phase, reason: 'not-forward' },
            '[bootcamp] phase transition REJECTED',
          );
          reply.status(400);
          return { error: `Invalid phase transition: ${existing.phase} → ${updates.phase} (must advance forward)` };
        }
        // Only allow advancing by 1 step, with defined skip exceptions:
        // - phase-2-env-check → phase-4-task-select (skip phase-3 when env is OK)
        // - phase-9-complete → phase-11-farewell (skip retro when farewell guide handles it)
        const gap = targetIdx - currentIdx;
        const allowedSkip =
          (existing.phase === 'phase-2-env-check' && updates.phase === 'phase-4-task-select') ||
          (existing.phase === 'phase-9-complete' && updates.phase === 'phase-11-farewell');
        const allowedLegacySkip = phaseWasLegacy && ALLOWED_LEGACY_SKIPS.has(`${currentPhase}→${updates.phase}`);
        if (gap > 1 && !allowedSkip && !allowedLegacySkip) {
          request.log.warn(
            { threadId, currentPhase, targetPhase: updates.phase, gap, reason: 'skip-not-allowed' },
            '[bootcamp] phase transition REJECTED',
          );
          reply.status(400);
          return { error: `Phase skip not allowed: ${existing.phase} → ${updates.phase} (max 1 step forward)` };
        }
        validTransition = true;
      }
    }

    // Build merged state — spreads preserve existing fields, updates override
    const raw: Record<string, unknown> = { ...existing };
    if (updates.phase !== undefined) raw.phase = updates.phase;
    if (updates.leadCat !== undefined) raw.leadCat = updates.leadCat;
    if (updates.selectedTaskId !== undefined) raw.selectedTaskId = updates.selectedTaskId;
    if (updates.envCheck !== undefined) raw.envCheck = updates.envCheck;
    if (updates.advancedFeatures !== undefined) raw.advancedFeatures = updates.advancedFeatures;
    if (updates.guideStep !== undefined) raw.guideStep = updates.guideStep;
    if (updates.completedAt !== undefined) raw.completedAt = updates.completedAt;

    await threadStore.updateBootcampState(threadId, raw as unknown as BootcampStateV1);

    // Push bootcamp state change to frontend via WebSocket
    socketManager.broadcastToRoom(`thread:${threadId}`, 'thread_updated', {
      threadId,
      bootcampState: raw,
    });

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
    if (!(await registry.isLatest(actor.invocationId))) {
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
