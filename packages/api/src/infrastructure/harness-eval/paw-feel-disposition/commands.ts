import {
  PAW_FEEL_NO_ACTION_REASONS,
  type PawFeelDispositionActor,
  type PawFeelDispositionEvent,
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
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('request_signature'),
      action: z.discriminatedUnion('type', [
        z.object({ type: z.literal('duplicate'), duplicateOf: nonEmptyString }).strict(),
        z.object({ type: z.literal('no_action'), reasonCode: z.enum(PAW_FEEL_NO_ACTION_REASONS) }).strict(),
        z.object({ type: z.literal('fix'), leaseId: nonEmptyString }).strict(),
      ]),
      preferredSignerCatId: nonEmptyString.optional(),
    })
    .strict(),
  commandBase
    .extend({
      type: z.literal('mark_blocked'),
      blockerCode: nonEmptyString,
      blockerRef: nonEmptyString,
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
  z.object({ type: z.literal('fix'), leaseId: nonEmptyString }).strict(),
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
  signatureAction?: PawFeelSignatureAction;
}

export function pawFeelCommandToEvent(
  actor: Extract<PawFeelDispositionActor, { kind: 'cat' | 'cvo' }>,
  command: PawFeelDispositionCommand,
  occurredAt: string,
  context: PawFeelResolvedCommandContext = {},
): PawFeelDispositionEvent {
  const base = { eventId: command.eventId, signalId: command.signalId, actor, occurredAt };
  switch (command.type) {
    case 'mark_seen':
      return { ...base, type: 'seen' };
    case 'route_pending':
      return {
        ...base,
        type: 'route_pending',
        ...(command.targetThreadId ? { targetThreadId: command.targetThreadId } : {}),
        ...(command.ownerEvidenceRef ? { ownerEvidenceRef: command.ownerEvidenceRef } : {}),
        ...(command.proposalId ? { proposalId: command.proposalId } : {}),
      };
    case 'confirm_routed':
      return {
        ...base,
        type: 'routed',
        receiptRef: command.receiptRef,
        ...(command.targetThreadId ? { targetThreadId: command.targetThreadId } : {}),
        ...(command.proposalId ? { proposalId: command.proposalId } : {}),
      };
    case 'route_reopened':
      return {
        ...base,
        type: 'route_reopened',
        rejectionRef: command.rejectionRef,
        reasonCode: command.reasonCode,
      };
    case 'close':
      return { ...base, type: 'closed', reasonCode: command.reasonCode, outcomeRef: command.outcomeRef };
    case 'mark_duplicate':
      if (!context.ownerCatId) throw new Error('duplicate requires named owner');
      return { ...base, type: 'duplicate', duplicateOf: command.duplicateOf, ownerCatId: context.ownerCatId };
    case 'mark_no_action':
      if (!context.ownerCatId) throw new Error('no_action requires named owner');
      return { ...base, type: 'no_action', reasonCode: command.reasonCode, ownerCatId: context.ownerCatId };
    case 'mark_fix':
      if (!context.fix) throw new Error('fix requires verified task and active lease');
      return {
        ...base,
        type: 'fix',
        ownerCatId: context.fix.ownerCatId,
        taskId: context.fix.taskId,
        leaseId: context.fix.leaseId,
        leaseGeneration: context.fix.leaseGeneration,
        custodyEvidenceRef: context.fix.custodyEvidenceRef,
      };
    case 'request_signature':
      if (!context.signatureAction) throw new Error('signature request requires a resolved action');
      return {
        ...base,
        type: 'signature_requested',
        action: context.signatureAction,
        ...(command.preferredSignerCatId ? { preferredSignerCatId: command.preferredSignerCatId } : {}),
      };
    case 'mark_blocked':
      return {
        ...base,
        type: 'blocked',
        blockerCode: command.blockerCode,
        blockerRef: command.blockerRef,
      };
  }
}
