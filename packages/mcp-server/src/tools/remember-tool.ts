import { randomUUID } from 'node:crypto';
import { deferredPersonMemoryInputSchema, proactiveMemoryAbstentionInputSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import {
  callbackPost,
  proposeEntityInputSchema,
  proposeEventMemoryCorrectionInputSchema,
  proposeProfileUpdateInputSchema,
  proposeTasteInputSchema,
} from './callback-tools.js';
import { matterAgentChangeSchema } from './matter-memory-tools.js';
import { proposePersonMemoryInputSchema } from './person-memory-proposal-tool.js';

const defineTool = defineMcpCanonicalFactory('remember-tool.ts', undefined, {
  resourceFamily: 'memory',
  authority: 'callback-owner',
});

const itemId = z.string().min(1).max(64).describe('Distinct id for this item within the request.');

function rememberItem<T extends string>(target: T, payload: z.ZodTypeAny) {
  return z.object({ itemId, target: z.literal(target), payload }).strict();
}

/**
 * One branch per memory kind. Each payload is the existing owner route's body, so the field rules
 * the old per-kind tools carried now live here (2026-11-13: the old write tools left the cat surface).
 */
const rememberItemInputSchema = z.discriminatedUnion('target', [
  rememberItem(
    'profile',
    z
      .object(proposeProfileUpdateInputSchema)
      .strict()
      .describe(
        'Durable fact about the authenticated person or this persona-operator relationship: personal context, preferred address, a relationship-specific communication boundary. ' +
          'targetLayer primer (default) = this persona relationship; corpus = owner-wide facts every cat should know; capsule = the 1–300 character opening portrait. ' +
          'Read the same layer with cat_cafe_read_profile first; afterContent replaces the whole file. For names/roles, state the subject cat, current agreement and original message coordinates. ' +
          'Nothing is written until the owner approves.',
      ),
  ),
  rememberItem(
    'taste',
    z
      .object(proposeTasteInputSchema)
      .strict()
      .describe(
        'Reusable judgment about what makes output, design, expression, architecture or system behavior good or bad (positive or negative). ' +
          'Create: scene, quote (original language — taste loses meaning when paraphrased), tags, dimension, privacy, and optional takeaway: a one-sentence hypothesis of what {{coCreator.name}} prefers, approved together with the quote and scene. ' +
          'Challenge an existing Taste memory instead: only target {sourceAnchor, expectedRevision, reason, suggestedPatch} plus optional clientRequestId; do not mix the two shapes. ' +
          'relationship-stance stores a reusable stance, not a personal fact. Public means the private home repository after owner approval.',
      ),
  ),
  rememberItem(
    'person',
    z
      .object(proposePersonMemoryInputSchema)
      .strict()
      .describe(
        'Owner-private memory for one named third-party person (F276): up to three owner-reported facts or assessments, a relationship, or one interaction event; never agent inference. ' +
          'Apply proactive-memory-judgment first; no explicit remember command or repetition threshold is needed. ' +
          'Every proposal needs a typed sourceBundle with assertion roles; the server validates each source against its actual owner-visible thread. For events include a readable narrative, importance/topic and uncertainty notes; preserve uncertain or conflicting time instead of guessing. ' +
          'Before the first durable write the server preflights the card, sources and budgets; a blocked proposal returns a machine-readable preflight action and creates nothing. ' +
          'GOTCHA: to correct a pending/not-now card pass replacesProposalId; it is a complete new pending snapshot, not a patch, and reusing one clientRequestId with a different replacesProposalId fails closed. Never route a private-memory correction into workspace Entity, and never model the correction itself as a new interaction event. ' +
          'If complete facts live in other owner-visible threads, stay in the current conversation and attach those exact messages as typed sources; each source drills to its original thread. Never send a zero-information card. ' +
          'Pass a printed ASR writeOpportunityRef verbatim. Not for workspace name/handle/alias mappings (use entity) or already materialized truth (use cat_cafe_revise_person_memory). Nothing becomes recallable until the owner approves exact items.',
      ),
  ),
  rememberItem(
    'person_defer',
    deferredPersonMemoryInputSchema.describe(
      'Capture a high-value delta for a known person (already registered private person or workspace person Entity) without interrupting the current task with an approval card. ' +
        'Only the subject plus exact message or attachment coordinates; the server derives owner and sources and stores no bodies. A bounded daily clerk may later turn it into a normal rejectable proposal. ' +
        'Not for first-time identity capture, vague reminders or unconfirmed ASR facts; include the owner confirmation message for ASR/attachments when available. ' +
        'When re-deferring a daily-clerk opportunity, pass both its writeOpportunityRef and reentryReceipt. Quiet: no group card is posted.',
    ),
  ),
  rememberItem(
    'person_abstain',
    proactiveMemoryAbstentionInputSchema.describe(
      'Record why you deliberately did not propose person memory for the current proactive-memory opportunity, after the proactive-memory-judgment gates. ' +
        'Pass a printed writeOpportunityRef verbatim when present. Never include transcript text, person details or source coordinates. Quiet: no group card is posted.',
    ),
  ),
  rememberItem(
    'entity',
    z
      .object(proposeEntityInputSchema)
      .strict()
      .describe(
        'Workspace entity for the registry: a verified durable name/handle/alias mapping with provenance, a registration nudge, or an explicit operator request. ' +
          'Not for an unverified bare name, bulk extraction, or owner-private facts about a person (use person). GOTCHA: correcting a pending/private F276 card is not an Entity mutation; use person with replacesProposalId. ' +
          'stance rejected/critique_target mark terms the registry should not match or entities under critique; visibilityScope is workspace.',
      ),
  ),
  rememberItem(
    'event_correction',
    z
      .object(proposeEventMemoryCorrectionInputSchema)
      .strict()
      .describe(
        'Source-bound correction of an existing Event memory you read: exact eventId and revision plus a bounded patch to interpretive fields. Never creates an Event or changes source identity; a stale revision is rejected, so reread instead of guessing.',
      ),
  ),
  rememberItem(
    'matter',
    matterAgentChangeSchema.describe(
      'Create, append to, correct or retire a shared matter page from exact original message selections (raw UTF-16 start/end, end exclusive). ' +
        'description is optional cat-written context and applicability; updates need expectedRevision from a fresh cat_cafe_read_memory_matter. Reuse requestId only for the exact same change.',
    ),
  ),
  rememberItem(
    'person_revision',
    z
      .record(z.string(), z.unknown())
      .describe(
        'Prefer cat_cafe_revise_person_memory. Same body with action correct_claim, retire_claim or amend_event.',
      ),
  ),
]);

export function handleRemember(input: { items: z.infer<typeof rememberItemInputSchema>[]; clientRequestId?: string }) {
  return callbackPost('/api/callbacks/remember', { ...input, clientRequestId: input.clientRequestId ?? randomUUID() });
}

export const rememberTools = [
  defineTool({
    name: 'cat_cafe_remember',
    description:
      'The write entry for memory: submit 1–4 items, each forwarded to its existing owner route. Choose target by semantic content (a correction, praise or Magic Word does not choose it): ' +
      'profile = facts about the person or this relationship; taste = reusable quality judgments; person = a named third party (F276); ' +
      'person_defer / person_abstain = quiet proactive-memory dispositions; entity = workspace name mappings; event_correction = fix an Event memory; matter = shared cross-thread quotes and decisions. ' +
      'NOT for repeated operational/tool/process rules (use code-as-harness), reading memory, approving proposals or forgetting data. ' +
      'Output: each original proposal/receipt or rejection plus a groupId; visible items share one Chat group card, quiet items post none. ' +
      'Approval, source checks, deduplication and direct-write rules still apply per item; one refusal does not undo another. Keep clientRequestId when retrying the same request.',
    inputSchema: {
      clientRequestId: z
        .string()
        .min(1)
        .max(160)
        .optional()
        .describe('Request key for the same set of items; one is generated when omitted.'),
      items: z
        .array(rememberItemInputSchema)
        .min(1)
        .max(4)
        .describe('1–4 items with distinct itemId; each target has its own payload fields.'),
    },
    handler: handleRemember,
    governance: {
      implementationExport: 'handleRemember',
      action: 'write',
      risk: { level: 'write', openWorld: false },
      runtimeProfiles: ['full'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/architecture/memory/remember-entry.md',
      },
    },
  }),
];
