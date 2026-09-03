import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

/**
 * The cat-facing half of the Phase 3 journey.
 *
 * The REST routes existed, but the actor who actually drives a Program is a cat, and a cat can only
 * reach what MCP exposes. `start` created a Program and `link_observation` connected its eyes, and
 * then the journey stopped: nothing could constitute the Program, open a round, or record an
 * evaluation. A contract that exists but that the actor cannot reach is not a reachable journey.
 *
 * These are thin entries onto the SAME canonical callback API — same service, same append path, same
 * owner resolution. They add no state machine, hold no owner truth, and accept nothing the REST
 * surface would not accept: the owner's verdict, cohort, ruler, discrimination, card and gate receipt
 * are resolved server-side from F267 and from the Program's own stream, never from these arguments.
 */

const defineTool = defineMcpCanonicalFactory('capability-evolution-round-tools.ts', undefined, {
  resourceFamily: 'evolution-program',
  authority: 'callback-owner',
});

const admissionReason = {
  disposition: 'accepted-boundary' as const,
  kind: 'resource-entry' as const,
  admissionRef: 'file:docs/features/F311-capability-evolution-workspace.md' as const,
};

const bounded = (max: number) => z.string().trim().min(1).max(max);
const ownerRef = z
  .object({
    ownerFeatureId: bounded(120),
    ownerStateRef: bounded(500).regex(/^[a-z][a-z0-9-]*:[^\s{}[\]"']+$/),
    version: bounded(240).optional(),
  })
  .strict();
const programId = z.string().regex(/^evolution-program:[0-9a-f]{32}$/);
const clientMessageId = bounded(240);
const expectedSequence = z.number().int().nonnegative();
const agentKeyCatId = bounded(120)
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared agent-key MCP variants; ignored under invocation auth.',
  );

export const constituteEvolutionProgramInputSchema = {
  programId: programId.describe('Exact canonical Evolution Program id.'),
  expectedSequence: expectedSequence.describe('Current Program sequence for CAS.'),
  clientMessageId: clientMessageId.describe('Stable idempotency id for this constitution.'),
  certificates: z
    .object({ goal: ownerRef, measurement: ownerRef, economic: ownerRef })
    .strict()
    .describe('Canonical refs to the goal, measurement and economic certificates; never their payload.'),
  valueOwnerRef: ownerRef.describe('Canonical ref to the value owner accountable for this Program.'),
  measurementRoleRefs: z
    .object({
      observer: ownerRef,
      domainOwner: ownerRef,
      consumer: ownerRef,
      calibrator: ownerRef,
      overlapJustification: bounded(1_000).optional(),
    })
    .strict()
    .describe('The four measurement roles as owner refs; overlap needs an explicit justification.'),
  agentKeyCatId,
};

export const openEvolutionRoundInputSchema = {
  programId: programId.describe('Exact canonical Evolution Program id.'),
  expectedSequence: expectedSequence.describe('Current Program sequence for CAS.'),
  clientMessageId: clientMessageId.describe('Stable idempotency id for this round request.'),
  evidenceProofRef: ownerRef.describe('Canonical F267 decision-proof ref whose exposure facts open this round.'),
  agentKeyCatId,
};

const attributionCandidate = z
  .object({
    layer: z.enum(['execution', 'harness', 'rubric', 'observation']),
    evidenceRefs: z.array(ownerRef).max(64),
  })
  .strict();

const evaluationAction = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('measurement'),
      measurement: z.object({ evidenceProofRef: ownerRef }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('attribution'),
      measurement: z.object({ evidenceProofRef: ownerRef }).strict(),
      attribution: z
        .object({
          rejudge: z
            .object({
              cells: z
                .array(
                  z
                    .object({
                      rubric: z.enum(['previous', 'current']),
                      candidate: z.enum(['previous', 'current']),
                      evidenceProofRef: ownerRef,
                    })
                    .strict(),
                )
                .max(16),
            })
            .strict()
            .optional(),
          baselineRebuildProofRef: ownerRef.optional(),
          candidates: z.array(attributionCandidate).max(4),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('intervention'), intervention: z.object({}).strict() }).strict(),
]);

export const recordEvolutionEvaluationInputSchema = {
  programId: programId.describe('Exact canonical Evolution Program id.'),
  expectedSequence: expectedSequence.describe('Current Program sequence for CAS.'),
  clientMessageId: clientMessageId.describe('Stable idempotency id for this evaluation step.'),
  action: evaluationAction.describe(
    'One evaluation step: measurement, attribution, or the intervention gate. Identities only.',
  ),
  agentKeyCatId,
};

export interface ConstituteEvolutionProgramInput {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  certificates: {
    goal: z.infer<typeof ownerRef>;
    measurement: z.infer<typeof ownerRef>;
    economic: z.infer<typeof ownerRef>;
  };
  valueOwnerRef: z.infer<typeof ownerRef>;
  measurementRoleRefs: {
    observer: z.infer<typeof ownerRef>;
    domainOwner: z.infer<typeof ownerRef>;
    consumer: z.infer<typeof ownerRef>;
    calibrator: z.infer<typeof ownerRef>;
    overlapJustification?: string;
  };
  agentKeyCatId?: string;
}

export interface OpenEvolutionRoundInput {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  evidenceProofRef: z.infer<typeof ownerRef>;
  agentKeyCatId?: string;
}

export interface RecordEvolutionEvaluationInput {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  action: z.infer<typeof evaluationAction>;
  agentKeyCatId?: string;
}

const at = (id: string, segment: string) => `/api/callbacks/evolution-programs/${encodeURIComponent(id)}/${segment}`;

export function handleConstituteEvolutionProgram(input: ConstituteEvolutionProgramInput): Promise<ToolResult> {
  return callbackPost(
    at(input.programId, 'constitution'),
    {
      expectedSequence: input.expectedSequence,
      clientMessageId: input.clientMessageId,
      certificates: input.certificates,
      valueOwnerRef: input.valueOwnerRef,
      measurementRoleRefs: input.measurementRoleRefs,
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export function handleOpenEvolutionRound(input: OpenEvolutionRoundInput): Promise<ToolResult> {
  return callbackPost(
    at(input.programId, 'evaluation-rounds'),
    {
      expectedSequence: input.expectedSequence,
      clientMessageId: input.clientMessageId,
      evidenceProofRef: input.evidenceProofRef,
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export function handleRecordEvolutionEvaluation(input: RecordEvolutionEvaluationInput): Promise<ToolResult> {
  return callbackPost(
    at(input.programId, 'evaluations'),
    {
      expectedSequence: input.expectedSequence,
      clientMessageId: input.clientMessageId,
      action: input.action,
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const capabilityEvolutionRoundTools = [
  defineTool({
    name: 'cat_cafe_constitute_evolution_program',
    description:
      'Constitute a started Evolution Program: bind its goal/measurement/economic certificates, its value owner, and the four measurement roles, moving it out of `constituting`. ' +
      'Use after cat_cafe_start_evolution_program, once the owners have produced canonical refs for each. ' +
      'NOT for: copying certificate payload, authoring a stage or lifecycle directly, or standing in for a certificate that does not exist yet. ' +
      'Output: appended/duplicate/conflict plus the canonical Program projection; the measurement certificate named here is later checked against the one F267 own verified proof is bound to. ' +
      'GOTCHA: shared persistent MCP callers pass agentKeyCatId so callback auth selects the matching Cat sidecar key.',
    inputSchema: constituteEvolutionProgramInputSchema,
    handler: handleConstituteEvolutionProgram,
    governance: {
      implementationExport: 'handleConstituteEvolutionProgram',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: admissionReason,
    },
  }),
  defineTool({
    name: 'cat_cafe_open_evolution_round',
    description:
      'Ask F192 to open an evaluation round for an observing Evolution Program. ' +
      'Use one canonical F267 decision-proof ref; the trigger receipt comes from F192 dispatch and the exposure proof from F267. ' +
      'NOT for: forcing a round open, authoring a trigger receipt, or resetting the Cycle to discard the previous diagnosis — F192 decides, and a declined dispatch leaves the Cycle where it is. ' +
      'Output: appended/duplicate/conflict, typed insufficient when the owner cannot prove exposure, or a typed refusal naming F192 outcome. ' +
      'GOTCHA: shared persistent MCP callers pass agentKeyCatId so callback auth selects the matching Cat sidecar key.',
    inputSchema: openEvolutionRoundInputSchema,
    handler: handleOpenEvolutionRound,
    governance: {
      implementationExport: 'handleOpenEvolutionRound',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: admissionReason,
    },
  }),
  defineTool({
    name: 'cat_cafe_record_evolution_evaluation',
    description:
      'Record one evaluation step on an open round: the measurement join, the four-layer attribution, or the intervention gate. ' +
      'Use identities only — one F267 decision-proof ref, plus for attribution the candidate layers with owner surface refs this Program already connected. ' +
      'NOT for: stating the owner verdict, the ruler, per-layer discrimination, the intervention card or the gate receipt; those are resolved from F267 and from the Program own stream, and a request carrying them is rejected. ' +
      'Output: appended/duplicate/conflict, or typed insufficient when the owner cannot prove what a step needs; a blocked gate records the zero-approval lane instead of an Approval. ' +
      'GOTCHA: shared persistent MCP callers pass agentKeyCatId so callback auth selects the matching Cat sidecar key.',
    inputSchema: recordEvolutionEvaluationInputSchema,
    handler: handleRecordEvolutionEvaluation,
    governance: {
      implementationExport: 'handleRecordEvolutionEvaluation',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: admissionReason,
    },
  }),
] as const;
