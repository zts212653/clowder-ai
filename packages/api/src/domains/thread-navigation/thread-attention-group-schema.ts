import { z } from 'zod';
import {
  isStableThreadAttentionGroupId,
  isStableThreadAttentionThreadId,
} from '../../config/user-preferences-thread-attention.js';

const threadId = z.string().refine(isStableThreadAttentionThreadId);
const groupId = z.string().refine(isStableThreadAttentionGroupId);
const name = z.string().trim().min(1).max(120);
const threadIds = z
  .array(threadId)
  .min(1)
  .max(1000)
  .refine((ids) => new Set(ids).size === ids.length);
const membership = z
  .object({ v: z.literal(1), groupId, order: z.number().int().min(0) })
  .strict()
  .nullable();
const group = z.object({ id: groupId, threadIds }).strict();
const undoEntry = z.object({ threadId, before: membership, after: membership }).strict();

export const groupCommandSchema = z
  .discriminatedUnion('action', [
    z
      .object({
        action: z.literal('create'),
        threadIds: threadIds.refine((ids) => ids.length >= 2 && ids.length <= 100),
        name: name.optional(),
      })
      .strict(),
    z.object({ action: z.literal('move'), groupId, threadId, beforeThreadId: threadId.optional() }).strict(),
    z.object({ action: z.literal('remove'), groupId, threadId }).strict(),
    z.object({ action: z.literal('rename'), groupId, name: name.nullable() }).strict(),
    z
      .object({
        action: z.literal('organize'),
        threadIds,
        name: name.optional(),
        groupId: groupId.optional(),
        expectedGroups: z.array(group).max(1000),
      })
      .strict(),
    z
      .object({
        action: z.literal('undo'),
        proof: z.string().max(128).optional(),
        entries: z
          .array(undoEntry)
          .min(1)
          .max(5000)
          .refine((entries) => new Set(entries.map((entry) => entry.threadId)).size === entries.length),
      })
      .strict(),
  ])
  .superRefine((command, ctx) => {
    if (
      command.action === 'organize' &&
      (Boolean(command.groupId) === Boolean(command.name) || (!command.groupId && command.threadIds.length < 2))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Choose an existing Group or name a new Group with at least two threads',
      });
    }
  });
