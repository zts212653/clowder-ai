import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireCallbackPrincipal } from '../../../routes/callback-auth-prehandler.js';
import type { CycleGovernanceCoordinator } from '../governance/CycleGovernanceCoordinator.js';
import type { CycleEvaluationCoordinator, CycleEvaluationPrincipal } from './CycleEvaluationCoordinator.js';
import type { HarnessUnitDescriber } from './HarnessUnitDescriber.js';

const identifier = z.string().trim().min(1).max(200);
const hookUnitId = z.string().regex(/^[A-Z]+\d+$/u);
const evidenceRefs = z.array(identifier).max(64);
const howCounted = z.string().trim().min(1).max(2_000);
const conclusion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('count'), value: z.number().int().nonnegative(), howCounted }).strict(),
  z.object({ kind: z.literal('rate-badness'), value: z.number().min(0).max(1), howCounted }).strict(),
  z
    .object({
      kind: z.literal('semantic-label'),
      label: z.string().trim().min(1).max(200),
      count: z.number().int().nonnegative(),
      howCounted,
    })
    .strict(),
]);
const coverageFinding = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('detector_gap'),
      basis: z.enum(['mcp-marker', 'evaluator-observation']),
      metricId: identifier,
      rationale: z.string().trim().min(1).max(2_000),
      evidenceRefs: z.array(identifier).min(1).max(16),
    })
    .strict(),
  z
    .object({
      kind: z.literal('metric_gap'),
      basis: z.literal('evaluator-observation'),
      rationale: z.string().trim().min(1).max(2_000),
      evidenceRefs: z.array(identifier).min(1).max(16),
    })
    .strict(),
]);
const coverageAssessment = z
  .object({
    status: z.enum(['adequate', 'data_insufficient', 'gaps_found']),
    rationale: z.string().trim().min(1).max(2_000),
    findings: z.array(coverageFinding).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.status === 'gaps_found') !== value.findings.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'gaps_found requires findings and only gaps_found may carry them',
      });
    }
  });

export const readCycleTracesBodySchema = z
  .object({
    objectiveId: identifier,
    cycleId: identifier,
    cursor: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(25).default(10),
  })
  .strict();

export const submitCycleEvaluationBodySchema = z
  .object({
    objectiveId: identifier,
    cycleId: identifier,
    metrics: z.array(z.object({ id: identifier, conclusion, evidenceRefs }).strict()).min(1),
    overall: z.enum(['complete', 'partial', 'insufficient_evidence']),
    counterexampleRootCauses: z
      .object({
        eventCount: z.number().int().nonnegative(),
        rootCauseCount: z.number().int().nonnegative(),
        howGrouped: z.string().trim().min(1).max(2_000),
      })
      .strict(),
    coverageAssessment,
  })
  .strict();

export const describeHarnessUnitBodySchema = z.object({ unitId: identifier }).strict();
const reason = z.string().trim().min(1).max(8_000);
const hookManifest = z
  .object({
    id: hookUnitId,
    name: z.string().trim().min(1).max(200),
    stage: z.enum(['session-init', 'per-turn']),
    order: z.number().int().nonnegative(),
    version: z.literal(1),
    enabled: z.boolean(),
    template: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u),
    resolver: z.never().optional(),
    inputs: z.array(identifier).max(32),
    variables: z
      .array(
        z
          .object({
            name: identifier,
            description: z.string().max(500).optional(),
            placeholder: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(64)
      .optional(),
    disableable: z.boolean(),
    safetyTier: z.enum(['readonly', 'limited-edit', 'editable']),
    transparencyTier: z.enum(['visible-by-default', 'opt-in-view', 'debug-only']),
    governanceTier: z.enum(['immutable', 'human-gated', 'auto-evolve']),
    userExplanation: z.string().max(2_000).optional(),
  })
  .strict();
const objectiveAttachment = z.object({ objectiveId: identifier, clauseId: identifier.optional() }).strict();
const governedCondition = z.discriminatedUnion('conditionRef', [
  z
    .object({
      conditionRef: z.literal('routing-mode-in'),
      params: z
        .object({
          values: z
            .array(z.enum(['independent', 'serial', 'parallel']))
            .min(1)
            .max(3),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ conditionRef: z.literal('prompt-tag-present'), params: z.object({ value: identifier }).strict() })
    .strict(),
  z
    .object({
      conditionRef: z.literal('minimum-teammates'),
      params: z.object({ count: z.number().int().min(0).max(64) }).strict(),
    })
    .strict(),
  z
    .object({
      conditionRef: z.literal('minimum-active-participants'),
      params: z.object({ count: z.number().int().min(0).max(64) }).strict(),
    })
    .strict(),
  ...(['voice-mode-is', 'mcp-available-is', 'a2a-enabled-is', 'direct-message-is'] as const).map((conditionRef) =>
    z.object({ conditionRef: z.literal(conditionRef), params: z.object({ value: z.boolean() }).strict() }).strict(),
  ),
]);
const governanceChange = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('enable'), unitId: identifier, reason }).strict(),
    z.object({ action: z.literal('disable'), unitId: identifier, reason }).strict(),
    z
      .object({
        action: z.literal('modify'),
        unitId: identifier,
        reason,
        proposedContent: z
          .string()
          .trim()
          .min(1)
          .max(128 * 1024)
          .optional(),
        proposedCondition: governedCondition.nullable().optional(),
      })
      .strict(),
    z
      .object({
        action: z.literal('add'),
        reason,
        unit: z
          .object({
            unitId: hookUnitId,
            assetSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
            manifest: hookManifest,
            content: z
              .string()
              .trim()
              .min(1)
              .max(128 * 1024),
            objectives: z.array(objectiveAttachment).min(1).max(16),
          })
          .strict(),
      })
      .strict(),
  ])
  .superRefine((change, ctx) => {
    if (change.action === 'modify' && change.proposedContent === undefined && change.proposedCondition === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'modify requires content or condition' });
    }
  });
export const submitCycleGovernanceBodySchema = z
  .object({
    objectiveId: identifier,
    cycleId: identifier,
    decision: z.enum(['keep', 'rollback', 'evolve']),
    reason,
    rollback: z.object({ unitId: identifier, targetVersion: z.number().int().positive() }).strict().optional(),
    v2Draft: z
      .object({ changes: z.array(governanceChange).min(1).max(16) })
      .strict()
      .optional(),
  })
  .strict();

type HandlerResult = { status: number; body: unknown };

export async function handleReadCycleTraces(
  coordinator: CycleEvaluationCoordinator,
  principal: CycleEvaluationPrincipal,
  rawBody: unknown,
): Promise<HandlerResult> {
  const parsed = readCycleTracesBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidBody(parsed.error.issues);
  try {
    return { status: 200, body: await coordinator.readTraces(principal, parsed.data) };
  } catch (error) {
    return cycleError(error);
  }
}

export async function handleSubmitCycleEvaluation(
  coordinator: CycleEvaluationCoordinator,
  principal: CycleEvaluationPrincipal,
  rawBody: unknown,
): Promise<HandlerResult> {
  const parsed = submitCycleEvaluationBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidBody(parsed.error.issues);
  try {
    return { status: 200, body: await coordinator.submitEvaluation(principal, parsed.data) };
  } catch (error) {
    return cycleError(error);
  }
}

export async function handleDescribeHarnessUnit(
  describer: HarnessUnitDescriber,
  rawBody: unknown,
): Promise<HandlerResult> {
  const parsed = describeHarnessUnitBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidBody(parsed.error.issues);
  try {
    return { status: 200, body: await describer.describe(parsed.data.unitId) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('harness_unit_not_found:'))
      return { status: 404, body: { error: 'harness_unit_not_found' } };
    if (message.startsWith('harness_hook_not_available:')) {
      return { status: 503, body: { error: 'harness_hook_not_available' } };
    }
    throw error;
  }
}

export async function handleSubmitCycleGovernance(
  coordinator: CycleGovernanceCoordinator,
  principal: CycleEvaluationPrincipal,
  rawBody: unknown,
): Promise<HandlerResult> {
  const parsed = submitCycleGovernanceBodySchema.safeParse(rawBody);
  if (!parsed.success) return invalidBody(parsed.error.issues);
  try {
    return { status: 200, body: await coordinator.submitGovernance(principal, parsed.data) };
  } catch (error) {
    return cycleError(error);
  }
}

export function registerCycleEvaluationCallbackRoutes(
  app: FastifyInstance,
  coordinator: CycleEvaluationCoordinator,
  describer: HarnessUnitDescriber,
  governance?: CycleGovernanceCoordinator,
): void {
  app.post('/api/callbacks/harness-signals/read-cycle-traces', async (request, reply) => {
    const principal = invocationPrincipal(request, reply);
    if (!principal) return;
    const result = await handleReadCycleTraces(coordinator, principal, request.body);
    reply.status(result.status);
    return result.body;
  });
  app.post('/api/callbacks/harness-signals/submit-cycle-evaluation', async (request, reply) => {
    const principal = invocationPrincipal(request, reply);
    if (!principal) return;
    const result = await handleSubmitCycleEvaluation(coordinator, principal, request.body);
    reply.status(result.status);
    return result.body;
  });
  app.post('/api/callbacks/harness-signals/describe-harness-unit', async (request, reply) => {
    if (!requireCallbackPrincipal(request, reply)) return;
    const result = await handleDescribeHarnessUnit(describer, request.body);
    reply.status(result.status);
    return result.body;
  });
  if (governance) {
    app.post('/api/callbacks/harness-signals/submit-cycle-governance', async (request, reply) => {
      const principal = invocationPrincipal(request, reply);
      if (!principal) return;
      const result = await handleSubmitCycleGovernance(governance, principal, request.body);
      reply.status(result.status);
      return result.body;
    });
  }
}

function invocationPrincipal(
  request: Parameters<typeof requireCallbackPrincipal>[0],
  reply: Parameters<typeof requireCallbackPrincipal>[1],
): CycleEvaluationPrincipal | null {
  const principal = requireCallbackPrincipal(request, reply);
  if (!principal) return null;
  if (principal.kind !== 'invocation') {
    reply.status(409).send({ error: 'current_invocation_required' });
    return null;
  }
  return { userId: principal.userId, catId: principal.catId, threadId: principal.threadId };
}

function invalidBody(issues: z.ZodIssue[]): HandlerResult {
  return { status: 400, body: { error: 'invalid_body', issues } };
}

function cycleError(error: unknown): HandlerResult {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith('cycle_evaluation_principal_mismatch:')) {
    return { status: 403, body: { error: 'cycle_evaluation_principal_mismatch' } };
  }
  if (message.startsWith('cycle_governance_principal_mismatch:')) {
    return { status: 403, body: { error: 'cycle_governance_principal_mismatch' } };
  }
  if (message.startsWith('cycle_governance_not_found:')) {
    return { status: 404, body: { error: 'cycle_governance_not_found' } };
  }
  if (message.startsWith('cycle_evaluation_not_found:')) {
    return { status: 404, body: { error: 'cycle_evaluation_not_found' } };
  }
  if (
    message.startsWith('cycle_evaluation_not_active:') ||
    message.startsWith('cycle_evaluation_conflict:') ||
    message.startsWith('cycle_governance_not_active:') ||
    message.startsWith('cycle_governance_conflict:') ||
    message.startsWith('cycle_trace_cursor_out_of_range:')
  ) {
    return { status: 409, body: { error: message.split(':', 1)[0] } };
  }
  if (
    message.startsWith('cycle_evaluation_metric_') ||
    message.startsWith('cycle_evaluation_evidence_limit:') ||
    message.startsWith('cycle_evaluation_invalid_evidence_ref:') ||
    message.startsWith('cycle_evaluation_rate_out_of_range') ||
    message.startsWith('cycle_evaluation_value_invalid') ||
    message.startsWith('cycle_record_too_large:')
  ) {
    return { status: 400, body: { error: 'invalid_cycle_evaluation', message } };
  }
  if (message.startsWith('cycle_governance_') || message.startsWith('harness_governance_')) {
    return { status: 400, body: { error: 'invalid_cycle_governance', message } };
  }
  throw error;
}
