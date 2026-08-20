import { z } from 'zod';
import { actionSuccessorMetadataObjectSchema, refineActionSuccessorMetadata } from './action-successor.js';

export const EXECUTABLE_ACTION_SUCCESSOR_CONTRACT_DESCRIPTION =
  'Executable action pairs are closed: review + reviewer + review_delivered, or implement + implementer + task_done. ' +
  'Example: actionFamily="review", successorSlot="reviewer", terminalPredicate.kind="review_delivered". ' +
  'merge/pr_merged and every other reserved vocabulary remain unavailable until their terminal completion producer is registered.';

const canonicalGitObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, 'expected a canonical 40- or 64-character lowercase Git OID');

const executableTerminalPredicateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('review_delivered'), headSha: canonicalGitObjectIdSchema }).strict(),
  z.object({ kind: z.literal('task_done') }).strict(),
]);

const executableActionSuccessorMetadataObjectSchema = actionSuccessorMetadataObjectSchema.extend({
  actionFamily: z.enum(['review', 'implement']),
  successorSlot: z.enum(['reviewer', 'implementer']),
  terminalPredicate: executableTerminalPredicateSchema.optional(),
});

/** MCP direct-carrier contract: only identities backed by the boot-asserted terminal registry. */
export const executableActionSuccessorMetadataSchema = executableActionSuccessorMetadataObjectSchema
  .superRefine((value, ctx) => {
    refineActionSuccessorMetadata(value, ctx);
    const kind = value.terminalPredicate?.kind;
    if (
      kind &&
      ((value.actionFamily === 'review' && kind !== 'review_delivered') ||
        (value.actionFamily === 'implement' && kind !== 'task_done'))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['terminalPredicate'],
        message: `${kind} is not executable for ${value.actionFamily}`,
      });
    }
  })
  .describe(EXECUTABLE_ACTION_SUCCESSOR_CONTRACT_DESCRIPTION);
