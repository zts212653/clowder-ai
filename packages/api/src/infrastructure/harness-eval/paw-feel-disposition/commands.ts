import {
  ownerTruthRefV1Schema,
  PAW_FEEL_NO_ACTION_REASONS,
  type PawFeelDirectRepairBindingV1,
  type PawFeelDirectRepairOutcomeV1,
  type PawFeelResumeConditionV1,
  type PawFeelSignatureAction,
} from '@cat-cafe/shared';
import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const commandBase = z
  .object({
    eventId: nonEmptyString,
    signalId: nonEmptyString,
    expectedSequence: z.number().int().nonnegative(),
  })
  .strict();

export const PawFeelResumeSelectorCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('task'),
      ref: z.object({ ownerFeatureId: nonEmptyString, ownerStateRef: nonEmptyString }).strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('owner_event'),
      ref: z.object({ ownerFeatureId: nonEmptyString, ownerStateRef: nonEmptyString }).strict(),
    })
    .strict(),
  z.object({ kind: z.literal('bounded_time'), recheckAt: z.string().datetime({ offset: true }) }).strict(),
]);

export const PawFeelDispositionCommandSchema = z.discriminatedUnion('type', [
  commandBase.extend({ type: z.literal('mark_seen') }).strict(),
  commandBase
    .extend({
      type: z.literal('route_pending'),
      targetThreadId: nonEmptyString.optional(),
      ownerEvidenceRef: nonEmptyString.optional(),
      proposalId: nonEmptyString.optional(),
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('confirm_routed'),
      targetThreadId: nonEmptyString.optional(),
      proposalId: nonEmptyString.optional(),
      receiptRef: nonEmptyString,
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('route_reopened'),
      rejectionRef: nonEmptyString,
      reasonCode: nonEmptyString,
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('close'),
      reasonCode: nonEmptyString,
      outcomeRef: nonEmptyString,
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('mark_duplicate'),
      duplicateOf: nonEmptyString,
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('mark_no_action'),
      reasonCode: z.enum(PAW_FEEL_NO_ACTION_REASONS),
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('mark_fix'),
      leaseId: nonEmptyString,
      actionRef: nonEmptyString,
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('link_repair_outcome'),
      bindingRef: ownerTruthRefV1Schema,
      ownerOutcomeRef: ownerTruthRefV1Schema,
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('request_signature'),
      action: z.discriminatedUnion('type', [
        z.object({ type: z.literal('duplicate'), duplicateOf: nonEmptyString }).strict(),
        z.object({ type: z.literal('no_action'), reasonCode: z.enum(PAW_FEEL_NO_ACTION_REASONS) }).strict(),
        z.object({ type: z.literal('fix'), leaseId: nonEmptyString, actionRef: nonEmptyString }).strict(),
      ]),
      preferredSignerCatId: nonEmptyString.optional(),
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('mark_blocked'),
      blockerCode: nonEmptyString,
      blockerRef: nonEmptyString,
      resume: PawFeelResumeSelectorCommandSchema,
    })
    .strict(),
]);

export type PawFeelDispositionCommand = z.infer<typeof PawFeelDispositionCommandSchema>;

export const PawFeelPrincipalSchema = z
  .object({
    kind: z.enum(['cat', 'cvo']),
    id: nonEmptyString,
  })
  .strict();

export const PawFeelCatPrincipalSchema = PawFeelPrincipalSchema.refine(
  (principal): principal is { kind: 'cat'; id: string } => principal.kind === 'cat',
  'cat principal required',
);

export const PawFeelTerminalActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('duplicate'), duplicateOf: nonEmptyString }).strict(),
  z.object({ type: z.literal('no_action'), reasonCode: z.enum(PAW_FEEL_NO_ACTION_REASONS) }).strict(),
  z.object({ type: z.literal('fix'), leaseId: nonEmptyString, actionRef: nonEmptyString }).strict(),
]);

export const PawFeelBundleActionSchema = z.discriminatedUnion('type', [
  ...PawFeelTerminalActionSchema.options,
  z
    .object({
      type: z.literal('request_signature'),
      action: PawFeelTerminalActionSchema,
      preferredSignerCatId: nonEmptyString.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('block'),
      blockerCode: nonEmptyString,
      blockerRef: nonEmptyString,
      resume: PawFeelResumeSelectorCommandSchema,
    })
    .strict(),
]);

const PawFeelBundleMemberSchema = z
  .object({
    signalId: nonEmptyString,
    expectedSequence: z.number().int().nonnegative(),
  })
  .strict();

export const PawFeelBundleCommandSchema = z
  .object({
    bundleKey: nonEmptyString,
    membershipToken: nonEmptyString,
    eventIdPrefix: nonEmptyString,
    members: z.array(PawFeelBundleMemberSchema).min(1).max(50),
    action: PawFeelBundleActionSchema,
    exceptions: z
      .array(
        z
          .object({
            signalId: nonEmptyString,
            action: PawFeelBundleActionSchema,
          })
          .strict(),
      )
      .max(50)
      .optional(),
  })
  .strict();

export type PawFeelBundleAction = z.infer<typeof PawFeelBundleActionSchema>;
export type PawFeelBundleCommand = z.infer<typeof PawFeelBundleCommandSchema>;

export interface PawFeelResolvedFix {
  ownerCatId: string;
  taskId: string;
  leaseId: string;
  leaseGeneration: number;
  custodyEvidenceRef: string;
}

export interface PawFeelResolvedCommandContext {
  ownerCatId?: string;
  fix?: PawFeelResolvedFix;
  directRepairBinding?: PawFeelDirectRepairBindingV1;
  repairOutcome?: PawFeelDirectRepairOutcomeV1;
  resumeCondition?: PawFeelResumeConditionV1;
  signatureAction?: PawFeelSignatureAction;
}

export { pawFeelCommandToEvent } from './service-internals/command-events.js';
