import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import {
  type F317MeetingSharePorts,
  F317MeetingShareService,
} from '../domains/concierge/meeting/f317-meeting-share-service.js';
import { resolveAudioServiceUrl } from './audio-proxy.js';
import { requirePluginOwnerLocalAccess } from './plugin-access-guards.js';

const intentSchema = z
  .object({
    callId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    generation: z.number().int().nonnegative(),
    captureThreadId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    meetingId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    captureStartedAt: z.number().finite().positive(),
    inputId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    inputLabel: z.string().min(1).max(256),
  })
  .strict();

const captureSchema = z
  .object({
    running: z.boolean(),
    paused: z.boolean(),
    thread_id: z.string(),
    meeting_id: z.string(),
    started_at: z.number(),
    inputs: z.array(
      z
        .object({
          id: z.string(),
          source: z.enum(['app', 'mic']),
          label: z.string(),
          state: z.string(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface F317MeetingShareRouteOptions {
  ownerUserId: string;
  threadStore: Pick<IThreadStore, 'get'>;
  host: Pick<F317MeetingSharePorts, 'observeCall' | 'attach' | 'detach' | 'isAttached'>;
  audioServiceUrl?: string;
  fetchFn?: typeof fetch;
}

export const f317MeetingShareRoutes: FastifyPluginAsync<F317MeetingShareRouteOptions> = async (app, options) => {
  const serviceUrl = (options.audioServiceUrl ?? resolveAudioServiceUrl()).replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const service = new F317MeetingShareService({
    ...options.host,
    ownerOfThread: async (threadId) => (await options.threadStore.get(threadId))?.createdBy ?? null,
    observeCapture: async () => {
      try {
        const response = await fetchFn(`${serviceUrl}/status`, { signal: AbortSignal.timeout(2_000) });
        if (!response.ok) return null;
        const parsed = captureSchema.safeParse(await response.json());
        if (!parsed.success) return null;
        const data = parsed.data;
        return {
          running: data.running,
          paused: data.paused,
          threadId: data.thread_id,
          meetingId: data.meeting_id,
          startedAt: data.started_at,
          inputs: data.inputs,
        };
      } catch {
        return null;
      }
    },
  });

  app.addHook('preHandler', async (request, reply) => {
    const access = requirePluginOwnerLocalAccess(request, request.method === 'GET' ? 'read' : 'write');
    if ('error' in access) return reply.code(access.status).send({ error: access.error });
    if (access.operator !== options.ownerUserId) return reply.code(403).send({ error: 'Host owner required' });
  });

  app.get('/api/concierge/meeting-share', async () => service.preview(options.ownerUserId));
  app.post('/api/concierge/meeting-share', async (request, reply) => {
    const intent = intentSchema.safeParse(request.body);
    if (!intent.success) return reply.code(400).send({ error: 'Exact meeting share coordinates required' });
    try {
      const grant = await service.share(options.ownerUserId, intent.data);
      return {
        sharing: true,
        grantId: grant.grantId,
        callId: grant.callId,
        meetingId: grant.meetingId,
        catId: grant.catId,
        inputLabel: grant.inputLabel,
      };
    } catch (error) {
      if (error instanceof Error && error.message === 'meeting_share_not_admitted')
        return reply.code(409).send({ error: 'Meeting or Live call changed; refresh and try again' });
      return reply.code(503).send({ error: 'Private meeting share unavailable' });
    }
  });
  app.delete('/api/concierge/meeting-share', async (_request, reply) => {
    try {
      await service.revoke(options.ownerUserId);
      return { sharing: false };
    } catch {
      return reply.code(503).send({ error: 'Meeting share teardown unconfirmed' });
    }
  });
  app.addHook('onClose', async () => {
    try {
      await service.revoke(options.ownerUserId);
    } catch {
      // The grant aborts before the Host detach attempt.
    }
  });
};
