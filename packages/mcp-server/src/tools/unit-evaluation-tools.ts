import { z } from 'zod';
import { defineMcpMigrationFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpMigrationFactory('unit-evaluation-tools.ts', undefined, {
  resourceFamily: 'harness-evaluation',
  authority: 'eval-callback',
});

const identifier = z.string().trim().min(1).max(200);
const hookUnitId = z.string().regex(/^[A-Z]+\d+$/u);
const evidenceRefs = z.array(identifier).max(64);
const howCounted = z.string().trim().min(1).max(2_000);
const conclusionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('count'), value: z.number().int().nonnegative(), howCounted }),
  z.object({ kind: z.literal('rate-badness'), value: z.number().min(0).max(1), howCounted }),
  z.object({
    kind: z.literal('semantic-label'),
    label: z.string().trim().min(1).max(200),
    count: z.number().int().nonnegative(),
    howCounted,
  }),
]);
const reason = z.string().trim().min(1).max(8_000);
const governedCondition = z.discriminatedUnion('conditionRef', [
  z.object({
    conditionRef: z.literal('routing-mode-in'),
    params: z.object({
      values: z
        .array(z.enum(['independent', 'serial', 'parallel']))
        .min(1)
        .max(3),
    }),
  }),
  z.object({ conditionRef: z.literal('prompt-tag-present'), params: z.object({ value: identifier }) }),
  z.object({
    conditionRef: z.literal('minimum-teammates'),
    params: z.object({ count: z.number().int().min(0).max(64) }),
  }),
  z.object({
    conditionRef: z.literal('minimum-active-participants'),
    params: z.object({ count: z.number().int().min(0).max(64) }),
  }),
  ...(['voice-mode-is', 'mcp-available-is', 'a2a-enabled-is', 'direct-message-is'] as const).map((conditionRef) =>
    z.object({ conditionRef: z.literal(conditionRef), params: z.object({ value: z.boolean() }) }),
  ),
]);
const hookManifest = z.object({
  id: hookUnitId,
  name: z.string().trim().min(1).max(200),
  stage: z.enum(['session-init', 'per-turn']),
  order: z.number().int().nonnegative(),
  version: z.literal(1),
  enabled: z.boolean(),
  template: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u),
  inputs: z.array(identifier).max(32),
  variables: z
    .array(
      z.object({
        name: identifier,
        description: z.string().max(500).optional(),
        placeholder: z.string().max(500).optional(),
      }),
    )
    .max(64)
    .optional(),
  disableable: z.boolean(),
  safetyTier: z.enum(['readonly', 'limited-edit', 'editable']),
  transparencyTier: z.enum(['visible-by-default', 'opt-in-view', 'debug-only']),
  governanceTier: z.enum(['immutable', 'human-gated', 'auto-evolve']),
  userExplanation: z.string().max(2_000).optional(),
});
const governanceChange = z
  .discriminatedUnion('action', [
    z.object({ action: z.literal('enable'), unitId: identifier, reason }),
    z.object({ action: z.literal('disable'), unitId: identifier, reason }),
    z.object({
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
    }),
    z.object({
      action: z.literal('add'),
      reason,
      unit: z.object({
        unitId: hookUnitId,
        assetSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
        manifest: hookManifest,
        content: z
          .string()
          .trim()
          .min(1)
          .max(128 * 1024),
        objectives: z
          .array(z.object({ objectiveId: identifier, clauseId: identifier.optional() }))
          .min(1)
          .max(16),
      }),
    }),
  ])
  .superRefine((change, ctx) => {
    if (change.action === 'modify' && change.proposedContent === undefined && change.proposedCondition === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'modify requires content or condition' });
    }
  });

export const readCycleTracesInputSchema = {
  objectiveId: identifier.describe('Objective id from the cycle assignment.'),
  cycleId: identifier.describe('Exact CycleRecord id from the assignment.'),
  cursor: z.number().int().nonnegative().default(0).describe('Cursor returned by the prior page; start at 0.'),
  limit: z.number().int().min(1).max(25).default(10).describe('Bounded trace page size (1-25).'),
};

export const submitCycleEvaluationInputSchema = {
  objectiveId: identifier.describe('Objective id from the cycle assignment.'),
  cycleId: identifier.describe('Exact CycleRecord id from the assignment.'),
  metrics: z
    .array(z.object({ id: identifier, conclusion: conclusionSchema, evidenceRefs }))
    .min(1)
    .describe('Exactly one conclusion for every metric in the assignment; references name inspected invocations.'),
  overall: z
    .enum(['complete', 'partial', 'insufficient_evidence'])
    .describe('Whether the evidence supports a complete, partial, or skipped evaluation.'),
  counterexampleRootCauses: z
    .object({
      eventCount: z.number().int().nonnegative(),
      rootCauseCount: z.number().int().nonnegative(),
      howGrouped: z.string().trim().min(1).max(2_000),
    })
    .describe(
      'Required audit bridge for the next M redesign: count all high-confidence counterexample events in the frozen windows, group them into semantic root causes, and explain the grouping.',
    ),
  coverageAssessment: z
    .object({
      status: z.enum(['adequate', 'data_insufficient', 'gaps_found']),
      rationale: z.string().trim().min(1).max(2_000),
      findings: z
        .array(
          z.discriminatedUnion('kind', [
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
          ]),
        )
        .max(16),
    })
    .strict()
    .superRefine((value, context) => {
      if ((value.status === 'gaps_found') !== value.findings.length > 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'gaps_found requires findings and only gaps_found may carry them',
        });
      }
    })
    .describe(
      'Required inferred detector-coverage assessment from the same full window. It may identify detector/metric gaps, but is diagnostic only and never metric truth.',
    ),
};

export const describeHarnessUnitInputSchema = {
  unitId: identifier.describe('Harness unit id attached to the Objective, such as S6 or D5.'),
};

export const submitCycleGovernanceInputSchema = {
  objectiveId: identifier.describe('Objective id from the governance assignment.'),
  cycleId: identifier.describe('Exact CycleRecord id from the governance assignment.'),
  decision: z.enum(['keep', 'rollback', 'evolve']).describe('Keep, roll back, or evolve the evaluated version.'),
  reason: reason.describe('Evidence-based reason for the governance decision.'),
  rollback: z
    .object({ unitId: identifier, targetVersion: z.number().int().positive() })
    .optional()
    .describe('Required only for rollback: one attached unit and a prior immutable version.'),
  v2Draft: z
    .object({ changes: z.array(governanceChange).min(1).max(16) })
    .optional()
    .describe('Required only for evolve. Merge is disable A plus modify B.'),
};

interface ReadCycleTracesInput extends Record<string, unknown> {
  objectiveId: string;
  cycleId: string;
  cursor: number;
  limit: number;
}

interface SubmitCycleEvaluationInput extends Record<string, unknown> {
  objectiveId: string;
  cycleId: string;
  metrics: Array<{ id: string; conclusion: z.infer<typeof conclusionSchema>; evidenceRefs: string[] }>;
  overall: 'complete' | 'partial' | 'insufficient_evidence';
  counterexampleRootCauses: { eventCount: number; rootCauseCount: number; howGrouped: string };
  coverageAssessment: import('@cat-cafe/shared').CycleCoverageAssessment;
}

interface DescribeHarnessUnitInput extends Record<string, unknown> {
  unitId: string;
}

interface SubmitCycleGovernanceInput extends Record<string, unknown> {
  objectiveId: string;
  cycleId: string;
  decision: 'keep' | 'rollback' | 'evolve';
  reason: string;
  rollback?: { unitId: string; targetVersion: number };
  v2Draft?: { changes: z.infer<typeof governanceChange>[] };
}

export async function handleReadCycleTracesTool(input: ReadCycleTracesInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/read-cycle-traces', input, { retryDelaysMs: [] });
}

export async function handleSubmitCycleEvaluationTool(input: SubmitCycleEvaluationInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/submit-cycle-evaluation', input, { retryDelaysMs: [] });
}

export async function handleDescribeHarnessUnitTool(input: DescribeHarnessUnitInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/describe-harness-unit', input, { retryDelaysMs: [] });
}

export async function handleSubmitCycleGovernanceTool(input: SubmitCycleGovernanceInput): Promise<ToolResult> {
  return callbackPost('/api/callbacks/harness-signals/submit-cycle-governance', input, { retryDelaysMs: [] });
}

export const unitEvaluationTools = [
  defineTool({
    name: 'cat_cafe_read_cycle_traces',
    description:
      'Read a bounded page of immutable owner traces for the exact F257 Objective cycle assigned to the current invocation. Counterexamples are returned first; cursor continuity is stateless and no trace bodies are copied into the assignment.',
    inputSchema: readCycleTracesInputSchema,
    handler: handleReadCycleTracesTool,
    governance: {
      implementationExport: 'handleReadCycleTracesTool',
      action: 'read-cycle-traces',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
  defineTool({
    name: 'cat_cafe_submit_cycle_evaluation',
    description:
      'Write the structured per-metric conclusions, counterexample event-to-root-cause grouping, and evidence-bound detector-coverage assessment for the exact F257 Objective cycle assigned to this invocation. Coverage findings are inferred diagnostics, never metric truth. The API validates metric coverage, conclusion kinds, grouping counts, evidence ownership, and cycle windows.',
    inputSchema: submitCycleEvaluationInputSchema,
    handler: handleSubmitCycleEvaluationTool,
    governance: {
      implementationExport: 'handleSubmitCycleEvaluationTool',
      action: 'submit-cycle-evaluation',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
  defineTool({
    name: 'cat_cafe_describe_harness_unit',
    description:
      'Describe one harness unit before drafting governance: allowed enable/disable/modify/add actions, effective state, active version, immutable version chain, and content pointers. This is read-only.',
    inputSchema: describeHarnessUnitInputSchema,
    handler: handleDescribeHarnessUnitTool,
    governance: {
      implementationExport: 'handleDescribeHarnessUnitTool',
      action: 'describe-harness-unit',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
  defineTool({
    name: 'cat_cafe_submit_cycle_governance',
    description:
      'Write keep/rollback/evolve for the exact F257 Objective cycle. rollback/evolve create a human approval card; this tool never applies hook changes directly.',
    inputSchema: submitCycleGovernanceInputSchema,
    handler: handleSubmitCycleGovernanceTool,
    governance: {
      implementationExport: 'handleSubmitCycleGovernanceTool',
      action: 'submit-cycle-governance',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
    },
  }),
] as const;
