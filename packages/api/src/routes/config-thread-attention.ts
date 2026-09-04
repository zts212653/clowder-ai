/** F277: owner-private cluster aliases and fold overrides. */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  isStableThreadAttentionAnchor,
  isStableThreadAttentionGroupId,
  isStableThreadAttentionThreadId,
  resolveThreadAttentionPreferences,
  saveThreadAttentionPreference,
} from '../config/user-preferences-thread-attention.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  applyThreadAttentionGroupCommand,
  resolveThreadAttentionGroups,
} from '../domains/thread-navigation/thread-attention-group-metadata.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveUserId } from '../utils/request-identity.js';

interface ThreadAttentionRoutesOptions {
  projectRoot: string;
  threadStore?: Pick<IThreadStore, 'list' | 'getThreadMetadata' | 'atomicMergeThreadMetadata'>;
}

const stableAnchorSchema = z.string().refine(isStableThreadAttentionAnchor, {
  message: 'anchor must be a stable group:attention_<id> anchor',
});
const putSchema = z
  .object({
    anchor: stableAnchorSchema,
    alias: z.string().trim().min(1).max(120).nullable().optional(),
    open: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((value) => value.alias !== undefined || value.open !== undefined, {
    message: 'alias or open is required',
  });
const threadIdSchema = z.string().refine(isStableThreadAttentionThreadId, {
  message: 'threadId must be an exact non-default thread id',
});
const groupIdSchema = z.string().refine(isStableThreadAttentionGroupId, {
  message: 'groupId must be a stable attention group id',
});
const groupCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      threadIds: z
        .array(threadIdSchema)
        .min(2)
        .max(100)
        .refine((threadIds) => new Set(threadIds).size === threadIds.length, {
          message: 'threadIds must be unique',
        }),
      name: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('move'),
      groupId: groupIdSchema,
      threadId: threadIdSchema,
      beforeThreadId: threadIdSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal('remove'), groupId: groupIdSchema, threadId: threadIdSchema }).strict(),
  z
    .object({
      action: z.literal('rename'),
      groupId: groupIdSchema,
      name: z.string().trim().min(1).max(120).nullable(),
    })
    .strict(),
]);
type GroupCommand = z.infer<typeof groupCommandSchema>;
type GroupStore = Pick<IThreadStore, 'list' | 'getThreadMetadata' | 'atomicMergeThreadMetadata'>;

function isGroupCommandNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === 'Conversation group not found' ||
      error.message === 'Thread not found' ||
      error.message === 'Target thread not found in Group')
  );
}

async function applyGroupCommand(
  store: GroupStore,
  projectRoot: string,
  userId: string,
  command: GroupCommand,
): Promise<void> {
  if (command.action === 'rename') {
    const groups = await resolveThreadAttentionGroups(store, userId);
    if (!groups.some((group) => group.id === command.groupId)) throw new Error('Conversation group not found');
    saveThreadAttentionPreference(projectRoot, {
      anchor: `group:${command.groupId}`,
      alias: command.name,
    });
    return;
  }

  await applyThreadAttentionGroupCommand(
    store,
    userId,
    command,
    command.action === 'create' && command.name
      ? (groups) => {
          const created = groups.find((group) =>
            command.threadIds.every((threadId) => group.threadIds.includes(threadId)),
          );
          if (!created) throw new Error('Created Group not found');
          saveThreadAttentionPreference(projectRoot, {
            anchor: `group:${created.id}`,
            alias: command.name,
          });
        }
      : undefined,
  );
}

function requireOwner(request: FastifyRequest, reply: FastifyReply): string | null {
  const operator = resolveUserId(request);
  if (!operator) {
    reply.status(401);
    return null;
  }
  const gateResult = resolveOwnerGate(operator, {
    errorMessage: 'Only the owner can access thread attention preferences',
  });
  if (gateResult) {
    reply.status(gateResult.status);
    return null;
  }
  return operator;
}

export async function configThreadAttentionRoutes(
  app: FastifyInstance,
  opts: ThreadAttentionRoutesOptions,
): Promise<void> {
  let mutationQueue: Promise<unknown> = Promise.resolve();
  const resolveSnapshot = async (userId: string) => {
    const preferences = resolveThreadAttentionPreferences(opts.projectRoot);
    const groups = opts.threadStore ? await resolveThreadAttentionGroups(opts.threadStore, userId) : [];
    return {
      ...preferences,
      groups: groups.map((group) => {
        const name = preferences.aliases[`group:${group.id}`];
        return name ? { ...group, name } : group;
      }),
    };
  };

  app.get('/api/config/thread-attention', async (request, reply) => {
    const userId = requireOwner(request, reply);
    if (!userId) return { error: 'Owner identity required' };
    return resolveSnapshot(userId);
  });

  app.put('/api/config/thread-attention', async (request, reply) => {
    const userId = requireOwner(request, reply);
    if (!userId) return { error: 'Owner identity required' };
    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    saveThreadAttentionPreference(opts.projectRoot, parsed.data);
    return resolveSnapshot(userId);
  });

  app.post('/api/config/thread-attention/groups', async (request, reply) => {
    const userId = requireOwner(request, reply);
    if (!userId) return { error: 'Owner identity required' };
    if (!opts.threadStore) {
      reply.status(503);
      return { error: 'Thread Group metadata store unavailable' };
    }
    const threadStore = opts.threadStore;
    const parsed = groupCommandSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const command = parsed.data;
    try {
      const execute = async () => {
        await applyGroupCommand(threadStore, opts.projectRoot, userId, command);
        return resolveSnapshot(userId);
      };
      const result = mutationQueue.then(execute, execute);
      mutationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return await result;
    } catch (error) {
      reply.status(isGroupCommandNotFound(error) ? 404 : 500);
      return { error: error instanceof Error ? error.message : 'Unable to update Group' };
    }
  });
}
