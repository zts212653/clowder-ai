/**
 * F171: First-Run Quest Callback Routes
 * POST /api/callbacks/update-quest-state — advance quest phase
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import { QUEST_PHASES, validateQuestTransition } from '../domains/cats/services/first-run-quest/quest-state.js';
import type { FirstRunQuestPhase, IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { deriveCallbackActor } from './callback-scope-helpers.js';

const questPhaseSchema = z.enum([...QUEST_PHASES]);

const updateQuestStateSchema = z.object({
  threadId: z.string().min(1),
  phase: questPhaseSchema.optional(),
  firstCatId: z.string().min(1).optional(),
  firstCatName: z.string().max(50).optional(),
  secondCatId: z.string().min(1).optional(),
  secondCatName: z.string().max(50).optional(),
  selectedTaskId: z.string().max(50).optional(),
  errorDetected: z.boolean().optional(),
  completedAt: z.number().optional(),
});

export function registerCallbackQuestRoutes(
  app: FastifyInstance,
  deps: { registry: InvocationRegistry; threadStore: IThreadStore },
): void {
  const { registry, threadStore } = deps;

  app.post('/api/callbacks/update-quest-state', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;

    const actor = deriveCallbackActor(record);

    // P2: Stale invocation guard — ignore if superseded by newer invocation
    if (!(await registry.isLatest(actor.invocationId))) {
      return { status: 'stale_ignored' };
    }

    const parsed = updateQuestStateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const { threadId, ...updates } = parsed.data;

    // P1: Cross-thread binding check — reject if invocation is bound to a different thread
    if (actor.threadId !== threadId) {
      reply.status(403);
      return { error: 'Cross-thread write rejected' };
    }
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    const existing = thread.firstRunQuestState ?? {
      v: 1 as const,
      phase: 'quest-0-welcome' as FirstRunQuestPhase,
      startedAt: Date.now(),
    };

    // Validate phase transition if requested
    if (updates.phase !== undefined) {
      const valid = validateQuestTransition(existing.phase, updates.phase);
      if (!valid) {
        reply.status(400);
        return {
          error: `Invalid quest phase transition: ${existing.phase} → ${updates.phase}`,
        };
      }
    }

    // Build merged state
    const merged = { ...existing };
    if (updates.phase !== undefined) merged.phase = updates.phase;
    if (updates.firstCatId !== undefined) merged.firstCatId = updates.firstCatId;
    if (updates.firstCatName !== undefined) merged.firstCatName = updates.firstCatName;
    if (updates.secondCatId !== undefined) merged.secondCatId = updates.secondCatId;
    if (updates.secondCatName !== undefined) merged.secondCatName = updates.secondCatName;
    if (updates.selectedTaskId !== undefined) merged.selectedTaskId = updates.selectedTaskId;
    if (updates.errorDetected !== undefined) merged.errorDetected = updates.errorDetected;
    if (updates.completedAt !== undefined) merged.completedAt = updates.completedAt;

    await threadStore.updateFirstRunQuestState(threadId, merged);

    const updated = await threadStore.get(threadId);
    return { questState: updated?.firstRunQuestState };
  });
}
