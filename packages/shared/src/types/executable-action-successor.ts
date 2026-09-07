import { z } from 'zod';
import { actionSuccessorMetadataObjectSchema, refineActionSuccessorMetadata } from './action-successor.js';

export const EXECUTABLE_ACTION_SUCCESSOR_CONTRACT_DESCRIPTION =
  'Direct executable action custody is closed to implement + implementer + task_done. ' +
  'Local cat review uses an ordinary durable handoff with localReviewVerdict + reviewedHeadSha + accepted-source fields; external review enters through an approved proposedAction and records its verdict through the external-review contract. ' +
  'review/reviewer, merge/pr_merged, and every other reserved pair are unavailable on direct carriers.';

const executableTerminalPredicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task_done') }).strict(),
]);

const executableActionSuccessorMetadataObjectSchema = actionSuccessorMetadataObjectSchema.extend({
  actionFamily: z.literal('implement'),
  successorSlot: z.literal('implementer'),
  terminalPredicate: executableTerminalPredicateSchema.optional(),
});

/** MCP direct-carrier contract: only identities backed by the boot-asserted terminal registry. */
export const executableActionSuccessorMetadataSchema = executableActionSuccessorMetadataObjectSchema
  .superRefine((value, ctx) => {
    refineActionSuccessorMetadata(value, ctx);
    const kind = value.terminalPredicate?.kind;
    if (kind && kind !== 'task_done') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminalPredicate'],
        message: `${kind} is not executable for ${value.actionFamily}`,
      });
    }
  })
  .describe(EXECUTABLE_ACTION_SUCCESSOR_CONTRACT_DESCRIPTION);
