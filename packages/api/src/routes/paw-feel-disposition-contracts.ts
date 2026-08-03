import { PAW_FEEL_INBOX_SORTS } from '@cat-cafe/shared';
import { z } from 'zod';
import {
  PawFeelBundleCommandSchema,
  type PawFeelDispositionCommand,
  PawFeelDispositionCommandSchema,
} from '../infrastructure/harness-eval/paw-feel-disposition/commands.js';

export const PawFeelInboxQuerySchema = z
  .object({
    states: z.string().optional(),
    sourceCatId: z.string().trim().min(1).optional(),
    sourceMessageId: z.string().trim().min(1).optional(),
    overdueOnly: z.enum(['true', 'false']).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: z.string().min(1).optional(),
    sort: z.enum(PAW_FEEL_INBOX_SORTS).optional(),
  })
  .strict();

export const PawFeelTriageBodySchema = z
  .object({
    commands: z.array(PawFeelDispositionCommandSchema).min(1).max(50),
  })
  .strict();

export const PawFeelCaptureBodySchema = z.object({ sourceMessageId: z.string().trim().min(1) }).strict();

export const PawFeelDutyUpdateBodySchema = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    primaryCatId: z.string().trim().min(1),
    backupCatId: z.string().trim().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.primaryCatId === value.backupCatId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'primary and backup duty cats must differ',
      });
    }
  });

export const PawFeelSingleActionBodySchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('duplicate'),
      eventId: z.string().trim().min(1),
      signalId: z.string().trim().min(1),
      expectedSequence: z.number().int().nonnegative(),
      duplicateOf: z.string().trim().min(1),
      ownerCatId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('no_action'),
      eventId: z.string().trim().min(1),
      signalId: z.string().trim().min(1),
      expectedSequence: z.number().int().nonnegative(),
      reasonCode: z.enum([
        'working_as_intended',
        'insufficient_evidence',
        'out_of_scope',
        'superseded',
        'not_actionable',
        'parser_false_positive',
      ]),
      ownerCatId: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('fix'),
      eventId: z.string().trim().min(1),
      signalId: z.string().trim().min(1),
      expectedSequence: z.number().int().nonnegative(),
      leaseId: z.string().trim().min(1),
    })
    .strict(),
]);

export const PawFeelBundleActionBodySchema = PawFeelBundleCommandSchema;

export function pawFeelSingleActionCommand(
  action: z.infer<typeof PawFeelSingleActionBodySchema>,
): PawFeelDispositionCommand {
  const base = {
    eventId: action.eventId,
    signalId: action.signalId,
    expectedSequence: action.expectedSequence,
  };
  if (action.type === 'duplicate') {
    return { ...base, type: 'mark_duplicate', duplicateOf: action.duplicateOf };
  }
  if (action.type === 'no_action') {
    return { ...base, type: 'mark_no_action', reasonCode: action.reasonCode };
  }
  return { ...base, type: 'mark_fix', leaseId: action.leaseId };
}
