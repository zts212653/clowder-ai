import {
  CLIENT_REQUEST_DIAGNOSTIC_HEADER,
  CONNECTION_DIAGNOSTIC_UUID,
  connectionDiagnosticBatchSchema,
  connectionDiagnosticRoute,
} from '@cat-cafe/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { resolveSessionUserId } from '../utils/request-identity.js';
import { authorizeOwnerBrowserAction } from './owner-memory-browser-auth.js';

/** Request-local timing only. These caller-supplied coordinates never become admission or idempotency identities. */
export function registerConnectionDiagnostics(app: FastifyInstance, slowIntervalMs = 5_000): void {
  const inflight = new WeakMap<FastifyRequest, (state: 'finish' | 'aborted', statusCode?: number) => void>();
  let windowStart = Date.now();
  let serverEvents = 0;
  let browserEvents = 0;
  function budget(source: 'server' | 'browser', amount = 1): boolean {
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now();
      serverEvents = 0;
      browserEvents = 0;
    }
    if (source === 'server') {
      if (serverEvents + amount > 1_200) return false;
      serverEvents += amount;
    } else {
      if (browserEvents + amount > 1_200) return false;
      browserEvents += amount;
    }
    return true;
  }

  app.addHook('onRequest', (request, reply, done) => {
    const incoming = request.headers[CLIENT_REQUEST_DIAGNOSTIC_HEADER];
    if (
      typeof incoming !== 'string' ||
      !CONNECTION_DIAGNOSTIC_UUID.test(incoming) ||
      request.url.startsWith('/api/diagnostics/')
    ) {
      done();
      return;
    }
    // Existing business stage logs inherit the same coordinate and retain Fastify's reqId.
    try {
      request.log = request.log.child({ clientRequestId: incoming });
    } catch {
      done();
      return;
    }
    const route = connectionDiagnosticRoute(request.url);
    const started = performance.now();
    const cpu = process.cpuUsage();
    const followThrough = (route === 'messages' && request.method === 'POST') || route === 'navigation_source';
    let lastTick = started;
    let ticks = 0;
    let finished = false;
    const emit = (state: 'start' | 'pending' | 'finish' | 'aborted', statusCode?: number, timerLagMs?: number) => {
      if (!budget('server')) return;
      try {
        const processCpu = process.cpuUsage(cpu);
        request.log.info(
          {
            event: 'connection_diagnostic',
            v: 1,
            source: 'server',
            state,
            route,
            method: request.method,
            durationMs: Math.round(performance.now() - started),
            statusCode,
            timerLagMs,
            processCpuUserMs: Math.round(processCpu.user / 1_000),
            processCpuSystemMs: Math.round(processCpu.system / 1_000),
            processRssBytes: process.memoryUsage.rss(),
          },
          'Connection diagnostic',
        );
      } catch {
        /* A logger failure cannot change an observed request. */
      }
    };
    const timer = setInterval(() => {
      const now = performance.now();
      emit('pending', undefined, Math.round(Math.max(0, now - lastTick - slowIntervalMs)));
      lastTick = now;
      if (++ticks >= 12) clearInterval(timer);
    }, slowIntervalMs);
    timer.unref();
    const close = () => {
      if (!reply.raw.writableFinished) finish('aborted');
    };
    const finish = (state: 'finish' | 'aborted', statusCode?: number) => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      reply.raw.off('close', close);
      if (
        followThrough ||
        ticks > 0 ||
        state === 'aborted' ||
        (statusCode ?? 0) >= 400 ||
        performance.now() - started >= 1_000
      )
        emit(state, statusCode);
    };
    reply.raw.once('close', close);
    inflight.set(request, finish);
    if (followThrough) emit('start');
    done();
  });
  app.addHook('onResponse', (request, reply, done) => {
    inflight.get(request)?.('finish', reply.statusCode);
    done();
  });

  app.post('/api/diagnostics/connection', { bodyLimit: 32_768 }, async (request, reply) => {
    if (!resolveSessionUserId(request)) return reply.code(401).send({ error: 'Session required' });
    if (!authorizeOwnerBrowserAction(request)) return reply.code(403).send({ error: 'Browser session required' });
    const parsed = connectionDiagnosticBatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid diagnostic payload' });
    if (!budget('browser', parsed.data.events.length))
      return reply.code(429).send({ error: 'Diagnostic budget exceeded' });
    for (const event of parsed.data.events) {
      try {
        request.log.info(
          { event: 'connection_diagnostic', v: 1, source: 'browser', trustedTiming: false, ...event },
          'Connection diagnostic',
        );
      } catch {
        /* Diagnostic ingress cannot fail a user operation. */
      }
    }
    return reply.code(204).send();
  });
}
