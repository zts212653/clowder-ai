/** F322: owner-private, per-thread conversation presentation preference. */

import { type ConversationViewPreference, conversationViewPreferenceSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  resolveConversationViewPreference,
  saveConversationViewPreference,
} from '../config/user-preferences-conversation-view.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

interface ConversationViewRoutesOptions {
  projectRoot: string;
  threadStore?: Pick<IThreadStore, 'get'>;
}

const querySchema = z.object({ threadId: z.string().trim().min(1) }).strict();
const putSchema = z.object({ threadId: z.string().trim().min(1), view: conversationViewPreferenceSchema }).strict();

function requireOwner(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = resolveStrictUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  const gateResult = resolveOwnerGate(userId, {
    errorMessage: 'Only the owner can access conversation view preferences',
  });
  if (gateResult) {
    reply.status(gateResult.status);
    return null;
  }
  return userId;
}

export async function configConversationViewRoutes(
  app: FastifyInstance,
  opts: ConversationViewRoutesOptions,
): Promise<void> {
  const resolveOwnedThread = async (threadId: string, userId: string, reply: FastifyReply) => {
    if (!opts.threadStore) {
      reply.status(503);
      return null;
    }
    const thread = await opts.threadStore.get(threadId);
    if (!thread || thread.createdBy !== userId) {
      reply.status(404);
      return null;
    }
    return thread;
  };

  app.get('/api/config/conversation-view', async (request, reply) => {
    const userId = requireOwner(request, reply);
    if (!userId) return { error: 'Owner identity required' };
    const parsed = querySchema.safeParse(request.query);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const thread = await resolveOwnedThread(parsed.data.threadId, userId, reply);
    if (!thread) return { error: reply.statusCode === 503 ? 'Thread store unavailable' : 'Thread not found' };
    return resolveConversationViewPreference(opts.projectRoot, thread.id, thread.participants);
  });

  app.put('/api/config/conversation-view', async (request, reply) => {
    const userId = requireOwner(request, reply);
    if (!userId) return { error: 'Owner identity required' };
    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request', details: parsed.error.issues };
    }
    const thread = await resolveOwnedThread(parsed.data.threadId, userId, reply);
    if (!thread) return { error: reply.statusCode === 503 ? 'Thread store unavailable' : 'Thread not found' };
    const view: ConversationViewPreference = parsed.data.view;
    if (view.mode === 'cat' && !thread.participants.some((catId) => catId === view.catId)) {
      reply.status(400);
      return { error: 'Selected cat is not a participant in this conversation' };
    }
    return saveConversationViewPreference(opts.projectRoot, thread.id, thread.participants, view);
  });
}
