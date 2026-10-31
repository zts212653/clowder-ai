import { RUNTIME_QUESTION_RETIREMENT } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { InvocationRegistry } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import {
  RuntimeInteractionError,
  type RuntimeInteractionService,
} from '../domains/runtime-interaction/RuntimeInteractionService.js';
import { registerCallbackAuthHook, requireCallbackAuth } from './callback-auth-prehandler.js';
import type { CallbackAuthSystemMessageNotifier } from './callback-auth-system-message.js';

export interface CallbackRuntimeInteractionRoutesOptions {
  registry: InvocationRegistry;
  callbackAuthNotifier?: CallbackAuthSystemMessageNotifier;
  service: RuntimeInteractionService;
}

const managementSchema = z
  .object({
    interactionId: z.string().trim().min(1),
    expectedRevision: z.number().int().positive(),
    operationId: z.string().trim().min(1).max(200),
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('settle_from_message'), responseMessageId: z.string().trim().min(1) }).strict(),
      z.object({ kind: z.literal('withdraw') }).strict(),
      z.object({ kind: z.literal('supersede'), replacementInteractionId: z.string().trim().min(1) }).strict(),
    ]),
  })
  .strict();
type ConversationManagementInput = z.infer<typeof managementSchema>;
type ConversationRequesterAuth = {
  userId: string;
  threadId: string;
  catId: string;
  ownerAuthProvenance: string;
  originTriggerMessageId?: string;
};

async function executeConversationManagement(
  service: RuntimeInteractionService,
  record: ConversationRequesterAuth,
  input: ConversationManagementInput,
) {
  const common = {
    interactionId: input.interactionId,
    requester: { userId: record.userId, threadId: record.threadId, catId: record.catId },
    expectedRevision: input.expectedRevision,
    operationId: input.operationId,
  };
  if (input.action.kind === 'settle_from_message') {
    return service.settleFromOwnerMessage({
      ...common,
      ownerMessageAuth: {
        ownerAuthProvenance: record.ownerAuthProvenance,
        ...(record.originTriggerMessageId ? { originTriggerMessageId: record.originTriggerMessageId } : {}),
      },
      responseMessageId: input.action.responseMessageId,
    });
  }
  if (input.action.kind === 'withdraw') return service.withdrawConversationDecision(common);
  return service.supersedeConversationDecision({
    ...common,
    replacementInteractionId: input.action.replacementInteractionId,
  });
}

function conversationManagementError(error: unknown, reply: import('fastify').FastifyReply) {
  if (!(error instanceof RuntimeInteractionError)) throw error;
  if (error.code === 'not_found' || error.code === 'unauthorized') {
    reply.status(404);
    return { error: 'Interaction not found' };
  }
  reply.status(error.code === 'invalid_response' ? 400 : 409);
  return { error: error.message, ...(error.reasonCode ? { reasonCode: error.reasonCode } : {}) };
}

/** Cached MCP clients receive guidance without creating a transient question. */
export const callbackRuntimeInteractionRoutes: FastifyPluginAsync<CallbackRuntimeInteractionRoutesOptions> = async (
  app,
  options,
) => {
  registerCallbackAuthHook(app, options.registry, {
    ...(options.callbackAuthNotifier ? { notifier: options.callbackAuthNotifier } : {}),
  });
  app.post('/api/callbacks/request-user-input', async (request, reply) => {
    if (!requireCallbackAuth(request, reply)) return;
    return reply.code(410).send(RUNTIME_QUESTION_RETIREMENT);
  });

  app.post('/api/callbacks/runtime-interactions/conversation/manage', async (request, reply) => {
    const record = requireCallbackAuth(request, reply);
    if (!record) return;
    const parsed = managementSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid conversation decision action', details: parsed.error.issues };
    }
    if (
      parsed.data.action.kind === 'settle_from_message' &&
      (record.ownerAuthProvenance !== 'strict' ||
        record.originTriggerMessageId !== parsed.data.action.responseMessageId)
    ) {
      reply.status(404);
      return { error: 'Interaction not found' };
    }
    try {
      const interaction = await executeConversationManagement(options.service, record, parsed.data);
      return { status: 'ok', interaction };
    } catch (error) {
      return conversationManagementError(error, reply);
    }
  });
};
