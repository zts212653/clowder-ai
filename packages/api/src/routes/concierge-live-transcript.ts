import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ConciergeThreadService } from '../domains/concierge/ConciergeThreadService.js';
import type { LiveCompanionSessions } from '../domains/concierge/live/LiveCompanionSessions.js';
import { projectLiveTranscript } from '../domains/concierge/live/live-transcript-projection.js';
import { requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

export function registerLiveTranscriptRoutes(
  app: FastifyInstance,
  options: {
    ownerUserId: string;
    messages: Pick<IMessageStore, 'getByThread'>;
    threads: Pick<ConciergeThreadService, 'getOrCreate' | 'isCurrent'>;
    sessions: Pick<LiveCompanionSessions, 'get'>;
  },
) {
  app.get<{ Params: { id: string } }>('/api/concierge/live/:id/transcript', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const access = requirePluginOwnerLocalAccess(request, 'read');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    if (access.operator !== options.ownerUserId) return reply.code(403).send({ error: 'Host owner required' });
    if (
      !z.string().uuid().safeParse(request.params.id).success ||
      !z.object({}).strict().safeParse(request.query).success
    )
      return reply.code(400).send({ error: 'Invalid transcript request' });
    const userId = access.operator;
    const current = options.sessions.get(request.params.id, userId);
    const threadId = current?.status().threadId ?? (await options.threads.getOrCreate(userId));
    if (!(await options.threads.isCurrent(userId, threadId)))
      return reply.code(409).send({ error: 'Companion conversation changed' });
    // A retired call has no session handle. Its history still comes from the
    // owner's canonical conversation, never from a renderer-selected thread.
    const rows = await options.messages.getByThread(threadId, 256, userId);
    const projection = projectLiveTranscript(
      rows,
      { userId, threadId, callId: request.params.id },
      rows.length === 256,
    );
    const savedSessions = new Set(
      projection.messages.flatMap((row) => (row.source.kind === 'voice' ? [row.source.realtimeSessionId] : [])),
    );
    const scope =
      current?.transcriptScope?.() ??
      (savedSessions.size === 1 ? { callId: request.params.id, realtimeSessionId: [...savedSessions][0]! } : undefined);
    return { kind: 'transcript', ...projection, ...(scope ? { scope } : {}) };
  });
}
