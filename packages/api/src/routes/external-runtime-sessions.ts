import type { CatId } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import type {
  RuntimeSessionExternalRegistrationBinding,
  RuntimeSessionMetadata,
  RuntimeSessionRuntime,
} from '../domains/cats/services/runtime-session/RuntimeSessionMetadata.js';
import type { IRuntimeSessionStore } from '../domains/cats/services/runtime-session/RuntimeSessionStore.js';
import type { ISessionChainStore } from '../domains/cats/services/stores/ports/SessionChainStore.js';
import {
  DEFAULT_THREAD_ID,
  type IThreadStore,
  type Thread,
} from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveUserId } from '../utils/request-identity.js';

interface ExternalRuntimeSessionsRouteOptions extends FastifyPluginOptions {
  sessionChainStore: ISessionChainStore;
  runtimeSessionStore: IRuntimeSessionStore;
  threadStore: IThreadStore;
}

const listQuerySchema = z.object({
  runtime: z.literal('antigravity-desktop').optional(),
  catId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const EXTERNAL_RUNTIME_SESSION_LIST_PAGE_SIZE = 200;

export async function externalRuntimeSessionsRoutes(
  app: FastifyInstance,
  opts: ExternalRuntimeSessionsRouteOptions,
): Promise<void> {
  const { sessionChainStore, runtimeSessionStore, threadStore } = opts;

  app.get<{ Querystring: Record<string, string | undefined> }>(
    '/api/external-runtime-sessions',
    async (request, reply) => {
      const userId = resolveUserId(request, { defaultUserId: 'default-user' });
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required' };
      }

      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'Invalid query', details: parsed.error.issues };
      }

      const callerCatId = request.headers['x-cat-id'] as string | undefined;
      if (callerCatId && parsed.data.catId && parsed.data.catId !== callerCatId) {
        reply.status(403);
        return { error: `Cannot query runtime sessions for cat '${parsed.data.catId}' — you are '${callerCatId}'` };
      }

      const limit = parsed.data.limit ?? 50;
      const sessions = await listReadableExternalRuntimeSessions({
        runtimeSessionStore,
        sessionChainStore,
        threadStore,
        runtime: parsed.data.runtime,
        catId: (callerCatId ?? parsed.data.catId) as CatId | undefined,
        userId,
        callerCatId,
        limit,
      });

      return { sessions };
    },
  );

  app.get<{ Params: { sessionId: string } }>('/api/external-runtime-sessions/:sessionId', async (request, reply) => {
    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required' };
    }

    const record = await runtimeSessionStore.getBySessionId(request.params.sessionId);
    if (!record || record.surface !== 'ide-direct') {
      reply.status(404);
      return { error: 'External runtime session not found' };
    }

    const callerCatId = request.headers['x-cat-id'] as string | undefined;
    const readable = await resolveReadableRuntimeSession(record, userId, callerCatId, sessionChainStore, threadStore);
    if (!readable) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    return formatExternalRuntimeSession(record, readable.thread);
  });
}

async function listReadableExternalRuntimeSessions({
  runtimeSessionStore,
  sessionChainStore,
  threadStore,
  runtime,
  catId,
  userId,
  callerCatId,
  limit,
}: {
  runtimeSessionStore: IRuntimeSessionStore;
  sessionChainStore: ISessionChainStore;
  threadStore: IThreadStore;
  runtime?: RuntimeSessionRuntime;
  catId?: CatId;
  userId: string;
  callerCatId?: string;
  limit: number;
}): Promise<Record<string, unknown>[]> {
  const sessions: Record<string, unknown>[] = [];
  let offset = 0;
  while (sessions.length < limit) {
    const records = await runtimeSessionStore.listRecent({
      runtime,
      surface: 'ide-direct',
      catId,
      limit: EXTERNAL_RUNTIME_SESSION_LIST_PAGE_SIZE,
      offset,
    });
    for (const record of records) {
      const readable = await resolveReadableRuntimeSession(record, userId, callerCatId, sessionChainStore, threadStore);
      if (!readable) continue;
      sessions.push(formatExternalRuntimeSession(record, readable.thread));
      if (sessions.length >= limit) break;
    }
    if (records.length < EXTERNAL_RUNTIME_SESSION_LIST_PAGE_SIZE) break;
    offset += EXTERNAL_RUNTIME_SESSION_LIST_PAGE_SIZE;
  }
  return sessions;
}

async function resolveReadableRuntimeSession(
  record: RuntimeSessionMetadata,
  userId: string,
  callerCatId: string | undefined,
  sessionChainStore: ISessionChainStore,
  threadStore: IThreadStore,
): Promise<{ thread: Thread } | null> {
  if (callerCatId && record.catId !== callerCatId) return null;
  const session = await sessionChainStore.get(record.sessionId);
  if (!session || session.userId !== userId || session.catId !== record.catId) return null;
  const thread = await threadStore.get(session.threadId);
  if (!thread) return null;
  if (thread.createdBy === userId) return { thread };
  if (thread.id === DEFAULT_THREAD_ID && thread.createdBy === 'system') return { thread };
  if (thread.externalRuntimeAnchorState?.userId === userId && record.userId === userId) return { thread };
  return null;
}

function formatExternalRuntimeSession(record: RuntimeSessionMetadata, thread: Thread): Record<string, unknown> {
  const sessionId = record.sessionId;
  const identity = record.identityHistory.at(-1);
  return {
    sessionId,
    threadId: record.threadId ?? thread.id,
    runtime: record.runtime,
    runtimeSessionId: record.runtimeSessionId,
    runtimeConversationId: record.runtimeConversationId,
    catId: record.catId,
    model: identity?.model,
    identityHistory: record.identityHistory,
    lastObservedAt: record.lifecycle.lastObservedAt,
    lifecycle: record.lifecycle,
    binding: record.externalRegistration?.binding ?? inferBinding(record.runtime, thread),
    provenance: record.externalRegistration?.provenance,
    title: record.externalRegistration?.title,
    drilldown: {
      sessionRecord: `/api/sessions/${sessionId}`,
      events: `/api/sessions/${sessionId}/events`,
      digest: `/api/sessions/${sessionId}/digest`,
    },
  };
}

function inferBinding(runtime: RuntimeSessionRuntime, thread: Thread): RuntimeSessionExternalRegistrationBinding {
  if (thread.externalRuntimeAnchorState?.runtime === runtime) {
    return { mode: 'orphan_anchor', anchorThreadId: thread.id };
  }
  return { mode: 'thread', threadId: thread.id, requestedBy: 'agent_key' };
}
