import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  runSaveTrace,
  SAVE_REQUEST_HEADER,
  SAVE_TRACE_HEADER,
  SAVE_UUID,
  saveDiagnostic,
  startSaveSpan,
  writeSaveDiagnostic,
} from '../utils/member-save-diagnostics.js';
import { resolveSessionUserId } from '../utils/request-identity.js';

const phase = z.enum([
  'save',
  'onboarding.entry',
  'member.write',
  'strategy.write',
  'codex.write',
  'refresh',
  'ui.commit',
  'session.wait',
  'session.refresh',
  'http.attempt',
]);
const eventSchema = z
  .object({
    seq: z.number().int().min(0).max(1024),
    phase,
    state: z.enum(['start', 'finish', 'failed', 'slow', 'aborted']),
    elapsedMs: z.number().finite().min(0).max(86_400_000),
    durationMs: z.number().finite().min(0).max(86_400_000).optional(),
    clientRequestId: z.string().regex(SAVE_UUID).optional(),
    attempt: z.number().int().min(1).max(2).optional(),
    statusCode: z.number().int().min(100).max(599).optional(),
    errorKind: z.enum(['timeout', 'aborted', 'network', 'other']).optional(),
  })
  .strict();
const payloadSchema = z
  .object({
    traceId: z.string().regex(SAVE_UUID),
    events: z.array(eventSchema).min(1).max(120),
  })
  .strict();

function tracedRoute(request: FastifyRequest): string | undefined {
  const path = request.url.split('?')[0] ?? '';
  if (/^\/api\/cats\/[a-zA-Z0-9_-]+$/.test(path) && request.method === 'PATCH') return '/api/cats/:id';
  if (path === '/api/cats' && request.method === 'POST') return path;
  if (/^\/api\/config\/session-strategy\/[a-zA-Z0-9_-]+$/.test(path) && request.method === 'PATCH')
    return '/api/config/session-strategy/:id';
  if (typeof request.headers[SAVE_TRACE_HEADER] === 'string' && SAVE_UUID.test(request.headers[SAVE_TRACE_HEADER])) {
    if (['/api/config', '/api/cats', '/api/config/cat-order'].includes(path)) return path;
  }
  return undefined;
}

/** Register on the root instance so ALS covers all save routes and their subscribers. */
export function registerMemberSaveDiagnostics(app: FastifyInstance, revision?: string, slowIntervalMs = 2000): void {
  const inflight = new WeakMap<
    FastifyRequest,
    { finish(state?: 'finish' | 'failed' | 'aborted', status?: number): void }
  >();
  app.addHook('onRequest', (request, reply, done) => {
    const route = tracedRoute(request);
    if (!route) {
      done();
      return;
    }
    const incoming = request.headers[SAVE_TRACE_HEADER];
    const traceId = typeof incoming === 'string' && SAVE_UUID.test(incoming) ? incoming : randomUUID();
    const clientId = request.headers[SAVE_REQUEST_HEADER];
    const context = {
      traceId,
      requestId: request.id,
      revision,
      log: app.log,
      ...(typeof clientId === 'string' && SAVE_UUID.test(clientId) ? { clientRequestId: clientId } : {}),
    };
    reply.header(SAVE_TRACE_HEADER, traceId);
    runSaveTrace(context, () => {
      const span = startSaveSpan('http.request', { route, method: request.method });
      let lastTick = performance.now();
      const timer = setInterval(() => {
        const now = performance.now();
        span.pending(Math.max(0, now - lastTick - slowIntervalMs));
        lastTick = now;
      }, slowIntervalMs);
      timer.unref();
      const close = () => {
        if (!reply.raw.writableFinished) finish('aborted');
      };
      const finish = (state: 'finish' | 'failed' | 'aborted' = 'finish', status?: number) => {
        clearInterval(timer);
        reply.raw.removeListener('close', close);
        span.finish(state, status);
      };
      reply.raw.once('close', close);
      inflight.set(request, { finish });
      span.run(done);
    });
  });
  app.addHook('onResponse', (request, reply, done) => {
    inflight.get(request)?.finish(reply.statusCode >= 400 ? 'failed' : 'finish', reply.statusCode);
    done();
  });
  const fields = new Set([
    'name',
    'displayName',
    'nickname',
    'clientId',
    'configurationSource',
    'accountRef',
    'defaultModel',
    'cli',
    'acp',
    'commandArgs',
    'cliConfigArgs',
    'voiceConfig',
    'contextWindow',
    'roleDescription',
    'personality',
    'teamStrengths',
    'caution',
    'strengths',
    'mentionPatterns',
    'color',
    'avatar',
    'roster',
    'key',
    'value',
    'expectedRevision',
  ]);
  app.addHook('preHandler', (request, _reply, done) => {
    if (inflight.has(request) && request.body && typeof request.body === 'object') {
      saveDiagnostic({
        phase: 'request.fields',
        state: 'snapshot',
        fields: Object.keys(request.body).filter((key) => fields.has(key)),
      });
    }
    done();
  });

  // Global bounded budget: neither user identifiers nor arbitrary payload strings are retained.
  let windowStart = Date.now(),
    received = 0;
  app.post('/api/diagnostics/member-save', { bodyLimit: 32_768 }, async (request, reply) => {
    if (!resolveSessionUserId(request)) return reply.code(401).send({ error: 'Session required' });
    const parsed = payloadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid diagnostic payload' });
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      received = 0;
    }
    if (received + parsed.data.events.length > 3000)
      return reply.code(429).send({ error: 'Diagnostic budget exceeded' });
    received += parsed.data.events.length;
    for (const event of parsed.data.events)
      writeSaveDiagnostic(
        { traceId: parsed.data.traceId, requestId: request.id, revision, log: app.log },
        { ...event, source: 'browser', trustedTiming: false },
      );
    return reply.code(204).send();
  });
}
