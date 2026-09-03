import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackGet, callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('capability-evolution-tools.ts', undefined, {
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
const ttlSeconds = z.number().int().positive().max(31_536_000);
const agentKeyCatId = bounded(120)
  .optional()
  .describe(
    'Persistent-agent identity selector. Required for shared agent-key MCP variants; ignored under invocation auth.',
  );
const commandAction = z.union([
  z.object({ type: z.literal('pause'), reasonRef: ownerRef }).strict(),
  z.object({ type: z.literal('resume'), resumeRef: ownerRef }).strict(),
  z
    .object({
      type: z.literal('needs_expert'),
      missingRole: z.enum(['observer', 'domain_owner', 'consumer', 'calibrator']),
      blockerRef: ownerRef,
    })
    .strict(),
  z.object({ type: z.literal('bind_expert'), roleOwnerRef: ownerRef }).strict(),
  z.object({ type: z.literal('withdraw'), decisionRef: ownerRef }).strict(),
  z.object({ type: z.literal('retention'), mode: z.literal('keep_forever'), retentionActionRef: ownerRef }).strict(),
  z
    .object({
      type: z.literal('retention'),
      mode: z.literal('forget_after'),
      ttlSeconds,
      retentionActionRef: ownerRef,
    })
    .strict(),
  z
    .object({
      type: z.literal('forget'),
      ttlSeconds,
      decisionRef: ownerRef,
      retentionActionRef: ownerRef,
    })
    .strict(),
]);

export const startEvolutionProgramInputSchema = {
  targetRef: ownerRef.describe('Canonical ref to the one capability/object being evolved; never copy its payload.'),
  clientMessageId: clientMessageId.describe('Stable idempotency id for the user message that requested this Program.'),
  agentKeyCatId,
};

export const getEvolutionProgramInputSchema = {
  programId: programId.optional().describe('Exact Program id. Omit to list all Programs in the caller workspace.'),
  agentKeyCatId,
};

export const updateEvolutionProgramInputSchema = {
  programId: programId.describe('Exact canonical Evolution Program id.'),
  expectedSequence: z.number().int().nonnegative().describe('Current Program sequence for CAS.'),
  clientMessageId: clientMessageId.describe('Stable idempotency id for this lifecycle command.'),
  action: commandAction.describe('One lifecycle command; owner truth remains ref-only.'),
  agentKeyCatId,
};

const trajectoryRef = ownerRef.refine(
  (value) => value.ownerFeatureId === 'F299' && /^inv:[^\s:]+$/.test(value.ownerStateRef),
  'trajectoryRef must be the canonical F299 inv:<id> ref',
);
const ownerSurfaceBinding = z
  .object({
    sourceKind: bounded(120).regex(/^[a-z0-9][a-z0-9-]*$/),
    ownerSurfaceRef: ownerRef,
    joinKey: bounded(500).regex(/^(?:thread|message|subject):[^\s{}[\]"']+$/),
    namedConsumerRef: ownerRef,
    instrumentationRef: ownerRef,
  })
  .strict();

export const linkEvolutionProgramObservationInputSchema = {
  programId: programId.describe('Exact canonical Evolution Program id.'),
  expectedSequence: z.number().int().nonnegative().describe('Current Program sequence for CAS.'),
  clientMessageId: clientMessageId.describe('Stable idempotency id for this observation link.'),
  trajectoryRef: trajectoryRef.describe('Canonical F299 inv:<id> trajectory ref; no trajectory payload.'),
  sourceBindings: z
    .array(ownerSurfaceBinding)
    .min(2)
    .max(128)
    .describe('Canonical owner refs, join keys, named consumers, and owner-held instrumentation refs.'),
  evidenceProofRef: ownerRef.describe('Canonical F267 decision-proof ref; no proof payload.'),
  agentKeyCatId,
};

export interface StartEvolutionProgramInput {
  targetRef: z.infer<typeof ownerRef>;
  clientMessageId: string;
  agentKeyCatId?: string;
}

export interface GetEvolutionProgramInput {
  programId?: string;
  agentKeyCatId?: string;
}

export interface UpdateEvolutionProgramInput {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  action: z.infer<typeof commandAction>;
  agentKeyCatId?: string;
}

export interface LinkEvolutionProgramObservationInput {
  programId: string;
  expectedSequence: number;
  clientMessageId: string;
  trajectoryRef: z.infer<typeof trajectoryRef>;
  sourceBindings: Array<z.infer<typeof ownerSurfaceBinding>>;
  evidenceProofRef: z.infer<typeof ownerRef>;
  agentKeyCatId?: string;
}

export function handleStartEvolutionProgram(input: StartEvolutionProgramInput): Promise<ToolResult> {
  return callbackPost(
    '/api/callbacks/evolution-programs',
    {
      targetRef: input.targetRef,
      clientMessageId: input.clientMessageId,
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export function handleGetEvolutionProgram(input: GetEvolutionProgramInput): Promise<ToolResult> {
  const path = input.programId
    ? `/api/callbacks/evolution-programs/${encodeURIComponent(input.programId)}`
    : '/api/callbacks/evolution-programs';
  return callbackGet(path, undefined, { agentKeyCatId: input.agentKeyCatId });
}

export function handleUpdateEvolutionProgram(input: UpdateEvolutionProgramInput): Promise<ToolResult> {
  return callbackPost(
    `/api/callbacks/evolution-programs/${encodeURIComponent(input.programId)}/commands`,
    {
      expectedSequence: input.expectedSequence,
      clientMessageId: input.clientMessageId,
      action: input.action,
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export function handleLinkEvolutionProgramObservation(
  input: LinkEvolutionProgramObservationInput,
): Promise<ToolResult> {
  return callbackPost(
    `/api/callbacks/evolution-programs/${encodeURIComponent(input.programId)}/observations`,
    {
      expectedSequence: input.expectedSequence,
      clientMessageId: input.clientMessageId,
      trajectoryRef: input.trajectoryRef,
      sourceBindings: input.sourceBindings,
      evidenceProofRef: input.evidenceProofRef,
    },
    { agentKeyCatId: input.agentKeyCatId },
  );
}

export const capabilityEvolutionTools = [
  defineTool({
    name: 'cat_cafe_start_evolution_program',
    description:
      'Start the permanent Evolution Program when the user says “我们来进化 X” or clearly asks to evolve one capability. ' +
      'Use only targetRef + clientMessageId: the server drafts the Goal/claim, economic and measurement refs, and role refs; typed blocker explains anything still missing，不让用户填写大表. ' +
      'NOT for: copying owner payload, caller-authored lifecycle/stage/certificates, mock cards, or a second queue. ' +
      'Output: appended/duplicate plus the canonical Program projection and its F307 Workbench surface descriptor. ' +
      'GOTCHA: shared persistent MCP callers pass agentKeyCatId so callback auth selects the matching Cat sidecar key.',
    inputSchema: startEvolutionProgramInputSchema,
    handler: handleStartEvolutionProgram,
    governance: {
      implementationExport: 'handleStartEvolutionProgram',
      action: 'create',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: admissionReason,
    },
  }),
  defineTool({
    name: 'cat_cafe_get_evolution_program',
    description:
      'Read the caller workspace canonical Evolution Program projection or list. ' +
      'Use for lifecycle, constitution progress, typed blockers, refs, and the next action. ' +
      'NOT for: reading owner payloads or inferring readiness beyond the projection. ' +
      'Output: the same durable truth consumed by REST and F307 Workbench. ' +
      'GOTCHA: shared persistent MCP callers pass agentKeyCatId so callback auth selects the matching Cat sidecar key.',
    inputSchema: getEvolutionProgramInputSchema,
    handler: handleGetEvolutionProgram,
    governance: {
      implementationExport: 'handleGetEvolutionProgram',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'readonly', 'agent-key'],
      standaloneReason: admissionReason,
    },
  }),
  defineTool({
    name: 'cat_cafe_link_evolution_program_observation',
    description:
      'Connect one permanent Evolution Program to real observation eyes after the source owners have produced canonical refs. ' +
      'Use only an F299 inv:<id> trajectory ref, at least two heterogeneous owner surface refs + join keys, the exact F311 named consumer refs, owner-held instrumentation refs, and one F267 decision-proof ref. ' +
      'NOT for: copying trajectory/evidence/decision payloads, inventing an instrumentation fallback, weakening missing proof, or creating a CEW query/scheduler ledger. ' +
      'Output: appended/duplicate/conflict or typed insufficient with the canonical Program projection; F192 owns event/quota/time triggering. ' +
      'GOTCHA: shared persistent MCP callers pass agentKeyCatId so callback auth selects the matching Cat sidecar key.',
    inputSchema: linkEvolutionProgramObservationInputSchema,
    handler: handleLinkEvolutionProgramObservation,
    governance: {
      implementationExport: 'handleLinkEvolutionProgramObservation',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: admissionReason,
    },
  }),
  defineTool({
    name: 'cat_cafe_update_evolution_program',
    description:
      'Append one audited lifecycle choice to a canonical Evolution Program using expected-sequence CAS. ' +
      'Use for pause, resume, needs_expert, bind_expert, withdraw, explicit retention, or atomic active forget. ' +
      'NOT for: direct stage changes, owner payload mutation, automatic TTL on close/sunset, or generic GC. ' +
      'Output: appended/duplicate/conflict plus the replayed Program projection. ' +
      'GOTCHA: shared persistent MCP callers pass agentKeyCatId so callback auth selects the matching Cat sidecar key.',
    inputSchema: updateEvolutionProgramInputSchema,
    handler: handleUpdateEvolutionProgram,
    governance: {
      implementationExport: 'handleUpdateEvolutionProgram',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full', 'agent-key'],
      standaloneReason: admissionReason,
    },
  }),
] as const;
