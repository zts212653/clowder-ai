import {
  evolutionPreparationBodyV1Schema,
  evolutionPreparationSectionSchema,
  evolutionPreparationSubmissionRefV1Schema,
} from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';
import type { ToolResult } from './file-tools.js';

const defineTool = defineMcpCanonicalFactory('capability-evolution-preparation-tools.ts', undefined, {
  resourceFamily: 'evolution-program',
  authority: 'callback-owner',
});

const admissionReason = {
  disposition: 'accepted-boundary' as const,
  kind: 'resource-entry' as const,
  admissionRef: 'file:docs/features/F311-capability-evolution-workspace.md' as const,
};

const programId = z.string().regex(/^evolution-program:[0-9a-f]{32}$/);
const clientMessageId = z.string().trim().min(1).max(240);
const expectedSequence = z.number().int().nonnegative();
const expectedCurrentSubmissionRef = evolutionPreparationSubmissionRefV1Schema.nullable();

export const beginEvolutionPreparationInputSchema = {
  programId: programId.describe('Exact canonical Evolution Program id.'),
  expectedSequence: expectedSequence.describe('Current Program sequence for CAS.'),
  clientMessageId: clientMessageId.describe('Stable idempotency id for this real work registration.'),
  section: evolutionPreparationSectionSchema.describe('Preparation reading coordinate where work is happening.'),
  itemId: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .optional()
    .describe('Optional stable item id inside the selected section.'),
  focus: z.string().trim().min(1).max(2_000).describe('Concrete work being performed by this invocation now.'),
  expectedCurrentSubmissionRef: expectedCurrentSubmissionRef.describe(
    'Exact current revision for this section, or null only when no revision exists.',
  ),
};

const submitShape = {
  programId: programId.describe('Exact canonical Evolution Program id.'),
  expectedSequence: expectedSequence.describe('Current Program sequence for CAS.'),
  clientMessageId: clientMessageId.describe('Stable idempotency id for this exact preparation submission.'),
  section: evolutionPreparationSectionSchema.describe('Preparation section receiving this revision.'),
  title: z.string().trim().min(1).max(240).describe('Readable title for this submitted preparation section.'),
  expectedCurrentSubmissionRef: expectedCurrentSubmissionRef.describe(
    'Exact current revision for this section, or null only when no revision exists.',
  ),
  dependsOn: z
    .array(evolutionPreparationSubmissionRefV1Schema)
    .max(3)
    .describe('Exact current refs of other preparation sections this content depends on.'),
  body: evolutionPreparationBodyV1Schema.describe(
    'Typed preparation content for exactly the selected section; unknown facts must remain unknown.',
  ),
};

export const submitEvolutionPreparationInputSchema = submitShape;
export const submitEvolutionPreparationCommandSchema = z
  .object(submitShape)
  .strict()
  .superRefine((value, context) => {
    if (value.section !== value.body.kind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['body'],
        message: 'body.kind must match section; example: section="object_map" with body.kind="object_map"',
      });
    }
  });

const beginEvolutionPreparationCommandSchema = z.object(beginEvolutionPreparationInputSchema).strict();

export type BeginEvolutionPreparationInput = z.infer<typeof beginEvolutionPreparationCommandSchema>;
export type SubmitEvolutionPreparationInput = z.infer<typeof submitEvolutionPreparationCommandSchema>;

export function handleBeginEvolutionPreparationWork(rawInput: BeginEvolutionPreparationInput): Promise<ToolResult> {
  const input = beginEvolutionPreparationCommandSchema.parse(rawInput);
  const { programId: id, ...body } = input;
  return callbackPost(`/api/callbacks/evolution-programs/${encodeURIComponent(id)}/preparation/work`, body);
}

export function handleSubmitEvolutionPreparation(rawInput: SubmitEvolutionPreparationInput): Promise<ToolResult> {
  const input = submitEvolutionPreparationCommandSchema.parse(rawInput);
  const { programId: id, ...body } = input;
  return callbackPost(`/api/callbacks/evolution-programs/${encodeURIComponent(id)}/preparation/submissions`, body);
}

export const capabilityEvolutionPreparationTools = [
  defineTool({
    name: 'cat_cafe_begin_evolution_preparation_work',
    description:
      'Register the current authenticated cat invocation as real work on one Evolution Program preparation section or item. ' +
      'Use when: you have read the current Program and are now actually investigating a candidate, rubric, measurement condition, or baseline question. ' +
      'NOT for: status narration, browser or persistent agent-key activity, validation/approval, stage changes, or claiming another cat is working. ' +
      'Output: appended/duplicate/conflict plus the exact preparation projection; live activity stops when F167 records the invocation terminal. ' +
      'GOTCHA: this creates visible work provenance—call it only immediately before doing that concrete work, with the exact current section revision.',
    inputSchema: beginEvolutionPreparationInputSchema,
    handler: handleBeginEvolutionPreparationWork,
    governance: {
      implementationExport: 'handleBeginEvolutionPreparationWork',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: admissionReason,
    },
  }),
  defineTool({
    name: 'cat_cafe_submit_evolution_preparation',
    description:
      'Commit one typed, immutable preparation section revision to its canonical Evolution Program and F117 Chat source. ' +
      'Use when: actual object-map, success-contract, measurement-plan, or baseline-diagnosis content is ready to hand off and read back. ' +
      'NOT for: certifying validity, adopting a candidate, advancing Program stage, uploading GT payloads, or replacing owner-held evidence. ' +
      'Output: a refs-only Program commit plus one durable Chat message body and the exact detail projection; stale refs return typed conflicts. ' +
      'GOTCHA: dependencies and current ref must be exact; after an interrupted submit retry the same clientMessageId and identical body to heal it—using a new id creates a new revision attempt.',
    inputSchema: submitEvolutionPreparationInputSchema,
    handler: handleSubmitEvolutionPreparation,
    governance: {
      implementationExport: 'handleSubmitEvolutionPreparation',
      action: 'update',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: admissionReason,
    },
  }),
] as const;
