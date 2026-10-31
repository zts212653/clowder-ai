import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LiveMeetingAudioError } from '../domains/concierge/meeting/live-meeting-audio-error.js';
import type { LiveMeetingControl } from '../domains/concierge/meeting/live-meeting-control.js';
import type { LiveMeetingPrincipal } from '../domains/concierge/meeting/live-meeting-control-contract.js';
import { type CallbackAuthRegistry, registerCallbackAuthHook } from './callback-auth-prehandler.js';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const empty = z.object({}).strict();
const start = z
  .object({
    requestMessageId: identifier.optional(),
    sourceId: z.string().min(1).max(256),
    mode: z.enum(['start', 'attach']),
  })
  .strict();
const stop = z.object({ requestMessageId: identifier.optional(), meetingId: z.string().min(1).optional() }).strict();

function controlError(reply: FastifyReply, error: unknown) {
  const reason = error instanceof Error ? error.message : 'meeting_control_unavailable';
  if (error instanceof LiveMeetingAudioError) return reply.code(error.statusCode).send({ error: reason });
  if (/owner_required|owner_mismatch|current_live_required|request_unavailable/.test(reason))
    return reply.code(403).send({ error: reason });
  if (/failed|unconfirmed|unavailable/.test(reason)) return reply.code(503).send({ error: reason });
  return reply.code(409).send({ error: reason });
}

function handler<T>(
  schema: z.ZodType<T>,
  expected: string,
  run: (principal: LiveMeetingPrincipal, input: T) => Promise<unknown>,
) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = request.callbackPrincipal;
    if (!principal || principal.kind !== 'invocation')
      return reply.code(401).send({ error: 'Current Live invocation required' });
    const parsed = schema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: expected });
    try {
      return await run(principal, parsed.data);
    } catch (error) {
      return controlError(reply, error);
    }
  };
}

/** Live-only capability. Owner, call, capture thread and microphone inputs are not model parameters. */
export const f317LiveMeetingControlRoutes: FastifyPluginAsync<{
  registry: CallbackAuthRegistry;
  service: LiveMeetingControl;
}> = async (app, options) => {
  registerCallbackAuthHook(app, options.registry);
  const service = options.service;
  const emptyError = 'Meeting scope is Host-owned; use an empty object';
  app.post(
    '/api/callbacks/meeting-sources',
    handler(empty, emptyError, (p) => service.sources(p)),
  );
  app.post(
    '/api/callbacks/meeting-status',
    handler(empty, emptyError, (p) => service.status(p)),
  );
  app.post(
    '/api/callbacks/meeting-start',
    handler(
      start,
      'Catalog sourceId and mode=start|attach required; optional exact requestMessageId; no extra authority fields',
      (p, input) => service.start(p, input),
    ),
  );
  app.post(
    '/api/callbacks/meeting-stop',
    handler(
      stop,
      'Optional exact requestMessageId and meetingId only; Host resolves the current owner stop request',
      (p, input) => service.stop(p, input.requestMessageId, input.meetingId),
    ),
  );
};
