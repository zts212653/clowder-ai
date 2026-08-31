import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCallbackPrincipal } from '../../../routes/callback-auth-prehandler.js';
import type { UnitSemanticEvaluationCoordinator } from './UnitSemanticEvaluationCoordinator.js';

export const retrieveUnitEvaluationBodySchema = z
  .object({
    jobId: z.string().min(1),
    cursor: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(25),
  })
  .strict();

export const submitUnitEvaluationBodySchema = z
  .object({
    jobId: z.string().min(1),
    labels: z.record(z.string().min(1), z.number().int().nonnegative()),
    explanation: z.string().trim().min(1),
  })
  .strict();

type CallbackPrincipal = { userId: string; catId: string };

export async function handleRetrieveUnitEvaluation(
  coordinator: UnitSemanticEvaluationCoordinator,
  principal: CallbackPrincipal,
  rawBody: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const parsed = retrieveUnitEvaluationBodySchema.safeParse(rawBody);
  if (!parsed.success) return { status: 400, body: { error: 'invalid_body', issues: parsed.error.issues } };
  try {
    const packet = await coordinator.retrieve(
      { ownerUserId: principal.userId, evaluatorCatId: principal.catId },
      parsed.data,
    );
    return { status: 200, body: packet as unknown as Record<string, unknown> };
  } catch (error) {
    return mapUnitEvaluationError(error);
  }
}

export async function handleSubmitUnitEvaluation(
  coordinator: UnitSemanticEvaluationCoordinator,
  principal: CallbackPrincipal,
  rawBody: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const parsed = submitUnitEvaluationBodySchema.safeParse(rawBody);
  if (!parsed.success) return { status: 400, body: { error: 'invalid_body', issues: parsed.error.issues } };
  try {
    const result = await coordinator.submit(
      { ownerUserId: principal.userId, evaluatorCatId: principal.catId },
      parsed.data,
    );
    return { status: 200, body: { outcome: 'accepted', jobId: parsed.data.jobId, ...result } };
  } catch (error) {
    return mapUnitEvaluationError(error);
  }
}

export function registerUnitEvaluationCallbackRoutes(
  app: FastifyInstance,
  coordinator: UnitSemanticEvaluationCoordinator,
): void {
  app.post('/api/callbacks/harness-signals/retrieve-unit-evaluation-traces', async (request, reply) => {
    const principal = requireInvocationPrincipal(request, reply);
    if (!principal) return;
    const result = await handleRetrieveUnitEvaluation(coordinator, principal, request.body);
    reply.status(result.status);
    return result.body;
  });

  app.post('/api/callbacks/harness-signals/submit-unit-evaluation', async (request, reply) => {
    const principal = requireInvocationPrincipal(request, reply);
    if (!principal) return;
    const result = await handleSubmitUnitEvaluation(coordinator, principal, request.body);
    reply.status(result.status);
    return result.body;
  });
}

function requireInvocationPrincipal(
  request: Parameters<typeof requireCallbackPrincipal>[0],
  reply: Parameters<typeof requireCallbackPrincipal>[1],
): CallbackPrincipal | null {
  const principal = requireCallbackPrincipal(request, reply);
  if (!principal) return null;
  if (principal.kind !== 'invocation') {
    reply.status(409).send({ error: 'current_invocation_required' });
    return null;
  }
  return { userId: principal.userId, catId: principal.catId };
}

function mapUnitEvaluationError(error: unknown): { status: number; body: Record<string, unknown> } {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('unit_semantic_job_not_found:')) {
    return { status: 404, body: { error: 'unit_semantic_job_not_found' } };
  }
  if (message.startsWith('unit_semantic_principal_mismatch:')) {
    return { status: 403, body: { error: 'unit_semantic_principal_mismatch' } };
  }
  if (message.startsWith('unit_semantic_completion_conflict:')) {
    return { status: 409, body: { error: 'unit_semantic_completion_conflict' } };
  }
  if (message.startsWith('unit_semantic_evidence_changed:')) {
    return { status: 409, body: { error: 'unit_semantic_evidence_changed' } };
  }
  if (
    message.startsWith('unit_semantic_invalid_') ||
    message.startsWith('unit_semantic_cursor_gap:') ||
    message.startsWith('semantic_evaluator_invalid_') ||
    message.startsWith('semantic_evaluator_no_traces_inspected:')
  ) {
    return { status: 400, body: { error: 'invalid_unit_semantic_evaluation', message } };
  }
  throw error;
}
