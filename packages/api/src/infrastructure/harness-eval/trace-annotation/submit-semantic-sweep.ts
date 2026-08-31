import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { advanceVolumeSweepDrain, getSemanticSweepCoordinator } from '../../../domains/prompt-hooks/trace-bootstrap.js';
import { requireCallbackPrincipal } from '../../../routes/callback-auth-prehandler.js';
import type { SemanticSweepCoordinator } from './SemanticSweepCoordinator.js';

const unitRefShape = z
  .object({
    unitType: z.literal('segment'),
    unitId: z.string().min(1),
    clauseId: z.string().min(1).optional(),
  })
  .strict();

const matchShape = z
  .object({
    objectiveId: z.string().min(1),
    metricId: z.string().min(1),
    unitRefs: z.array(unitRefShape).min(1),
    polarity: z.enum(['counterexample', 'positive']),
    confidence: z.number().min(0).max(1),
    explanation: z.string().min(1),
  })
  .strict();

const decisionShape = z
  .object({
    invocationId: z.string().min(1),
    status: z.enum(['matched', 'irrelevant', 'unscorable']),
    matches: z.array(matchShape),
  })
  .strict();

export const submitSemanticSweepBodySchema = z
  .object({
    jobId: z.string().min(1),
    decisions: z.array(decisionShape).min(1),
  })
  .strict();

export async function handleSubmitSemanticSweep(
  coordinator: SemanticSweepCoordinator,
  principal: { userId: string; catId: string },
  rawBody: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const parsed = submitSemanticSweepBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return {
      status: 400,
      body: { error: 'invalid_body', issues: parsed.error.issues },
    };
  }
  try {
    const result = await coordinator.submit(
      { ownerUserId: principal.userId, evaluatorCatId: principal.catId },
      parsed.data,
    );
    const { alreadyCompleted, unitEvaluationReady, ...publicResult } = result;
    // F257: advance the persistent volume-sweep generation only when this
    // submission matches its active jobId, then wake the next batch.
    await advanceVolumeSweepDrain(
      principal.userId,
      parsed.data.jobId,
      !alreadyCompleted && unitEvaluationReady === true,
    );
    return { status: 200, body: { outcome: 'accepted', jobId: parsed.data.jobId, ...publicResult } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('semantic_sweep_job_not_found:')) {
      return { status: 404, body: { error: 'semantic_sweep_job_not_found' } };
    }
    if (message.startsWith('semantic_sweep_principal_mismatch:')) {
      return { status: 403, body: { error: 'semantic_sweep_principal_mismatch' } };
    }
    if (
      message.startsWith('semantic_sweep_unknown_invocation:') ||
      message.startsWith('invalid_evaluation_coordinate:')
    ) {
      return { status: 400, body: { error: 'invalid_semantic_sweep_submission', message } };
    }
    if (message.startsWith('semantic_sweep_completion_conflict:')) {
      return { status: 409, body: { error: 'semantic_sweep_completion_conflict' } };
    }
    throw error;
  }
}

export function registerSubmitSemanticSweepRoute(
  app: FastifyInstance,
  injectedCoordinator?: SemanticSweepCoordinator,
): void {
  app.post('/api/callbacks/harness-signals/submit-semantic-sweep', async (request, reply) => {
    const principal = requireCallbackPrincipal(request, reply);
    if (!principal) return;
    if (principal.kind !== 'invocation') {
      reply.status(409);
      return { error: 'current_invocation_required' };
    }
    const coordinator = injectedCoordinator ?? getSemanticSweepCoordinator();
    if (!coordinator) {
      reply.status(503);
      return { error: 'semantic_sweep_coordinator_unavailable' };
    }
    const result = await handleSubmitSemanticSweep(
      coordinator,
      { userId: principal.userId, catId: principal.catId },
      request.body,
    );
    reply.status(result.status);
    return result.body;
  });
}
