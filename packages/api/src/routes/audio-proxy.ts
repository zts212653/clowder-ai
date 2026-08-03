/**
 * F195 Phase B — Audio proxy routes.
 *
 * Proxies frontend requests to the standalone Python audio-service (:9881).
 * The frontend cannot hit localhost:9881 directly (CORS / deployment boundary).
 */

import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { getServiceConfig } from '../domains/services/service-config.js';
import { getServiceManifest, resolveServiceEndpoint } from '../domains/services/service-manifest.js';
import { resolveUserId } from '../utils/request-identity.js';

function resolveAudioServiceUrl(): string {
  const service = getServiceManifest('audio-capture');
  if (!service) return process.env.AUDIO_SERVICE_URL ?? 'http://127.0.0.1:9881';
  return resolveServiceEndpoint(service, process.env, getServiceConfig('audio-capture')) ?? 'http://127.0.0.1:9881';
}

function requireIdentity(request: FastifyRequest, reply: FastifyReply): boolean {
  const userId = resolveUserId(request, {});
  if (!userId) {
    reply.status(401).send({ error: 'Identity required' });
    return false;
  }
  return true;
}

async function proxyJson(reply: FastifyReply, method: string, path: string, body?: unknown): Promise<void> {
  const resp = await fetch(`${resolveAudioServiceUrl()}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  return reply.status(resp.status).send(data);
}

type ActiveCaptureLease = {
  token: string;
  threadId: string;
  heartbeat: NodeJS.Timeout;
  expiresAtMs: number;
};

const CONTROLLER_LEASE_TTL_S = 15;
const SHUTDOWN_STOP_TIMEOUT_MS = 5_000;

function captureBody(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export const audioProxyRoutes: FastifyPluginAsync = async (app) => {
  let activeLease: ActiveCaptureLease | null = null;

  const releaseLease = (lease: ActiveCaptureLease): void => {
    clearInterval(lease.heartbeat);
    if (activeLease === lease) activeLease = null;
  };

  const releaseLeaseIfExpired = (lease: ActiveCaptureLease | null): boolean => {
    if (!lease || Date.now() < lease.expiresAtMs) return false;
    releaseLease(lease);
    return true;
  };

  const getActiveLease = (): ActiveCaptureLease | null => {
    const lease = activeLease;
    return releaseLeaseIfExpired(lease) ? null : lease;
  };

  const renewLease = async (): Promise<void> => {
    const lease = activeLease;
    if (!lease) return;
    try {
      const resp = await fetch(`${resolveAudioServiceUrl()}/lease`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lease_token: lease.token, thread_id: lease.threadId }),
        signal: AbortSignal.timeout(2_000),
      });
      if (!resp.ok) {
        app.log.warn({ status: resp.status }, 'audio controller lease was rejected; capture will expire');
        releaseLease(lease);
      } else if (activeLease === lease) {
        lease.expiresAtMs = Date.now() + CONTROLLER_LEASE_TTL_S * 1000;
      }
    } catch (error) {
      if (releaseLeaseIfExpired(lease)) {
        app.log.warn({ err: error }, 'audio controller lease expired after renewal failures');
      } else {
        // Keep retrying transient transport failures until the last confirmed
        // renewal expires. The sidecar independently finalizes on the same TTL.
        app.log.warn({ err: error }, 'audio controller lease renewal failed');
      }
    }
  };

  app.addHook('onClose', async () => {
    const lease = activeLease;
    activeLease = null;
    if (!lease) return;
    clearInterval(lease.heartbeat);
    try {
      const resp = await fetch(`${resolveAudioServiceUrl()}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lease_token: lease.token,
          reason: 'runtime-graceful-shutdown',
        }),
        signal: AbortSignal.timeout(SHUTDOWN_STOP_TIMEOUT_MS),
      });
      if (!resp.ok) {
        app.log.warn({ status: resp.status }, 'audio capture graceful stop was rejected; waiting for lease expiry');
      }
    } catch (error) {
      // A failed graceful stop still converges through controller lease expiry.
      app.log.warn({ err: error }, 'audio capture graceful stop failed; waiting for lease expiry');
    }
  });

  app.post('/api/audio/start', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    const body = captureBody(req.body);
    const threadId = body?.thread_id;
    if (typeof threadId !== 'string' || !threadId.trim()) {
      return reply.status(400).send({ error: 'thread_id is required for active audio capture' });
    }
    if (getActiveLease()) {
      return reply.status(409).send({ error: 'Audio capture is already owned by this runtime' });
    }
    try {
      const resp = await fetch(`${resolveAudioServiceUrl()}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...body,
          thread_id: threadId.trim(),
          controller_id: `api-runtime:${process.pid}:${randomUUID()}`,
          lease_ttl_s: CONTROLLER_LEASE_TTL_S,
        }),
      });
      const data = (await resp.json()) as Record<string, unknown>;
      if (!resp.ok) return reply.status(resp.status).send(data);
      const token = data.lease_token;
      if (typeof token !== 'string' || !token) {
        return reply.status(502).send({ error: 'Audio service start omitted controller lease token' });
      }
      const heartbeat = setInterval(() => void renewLease(), (CONTROLLER_LEASE_TTL_S * 1000) / 3);
      heartbeat.unref();
      activeLease = {
        token,
        threadId: threadId.trim(),
        heartbeat,
        expiresAtMs: Date.now() + CONTROLLER_LEASE_TTL_S * 1000,
      };
      const clientData = { ...data };
      delete clientData.lease_token;
      return reply.send(clientData);
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.post('/api/audio/stop', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    const lease = getActiveLease();
    if (!lease) {
      return reply.status(409).send({ error: 'No audio capture lease is owned by this runtime' });
    }
    try {
      const resp = await fetch(`${resolveAudioServiceUrl()}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lease_token: lease.token, reason: 'controller-stop' }),
      });
      const data = await resp.json();
      if (resp.ok) {
        releaseLease(lease);
      }
      return reply.status(resp.status).send(data);
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.get('/api/audio/status', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'GET', '/status');
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.get<{ Querystring: { from?: string; to?: string; latest?: string; mode?: string; format?: string } }>(
    '/api/audio/transcript',
    async (req, reply) => {
      if (!requireIdentity(req, reply)) return;
      try {
        const params = new URLSearchParams();
        if (req.query.from) params.set('from', req.query.from);
        if (req.query.to) params.set('to', req.query.to);
        if (req.query.latest) params.set('latest', req.query.latest);
        if (req.query.mode) params.set('mode', req.query.mode);
        if (req.query.format) params.set('format', req.query.format);
        const qs = params.toString();
        return await proxyJson(reply, 'GET', `/transcript${qs ? `?${qs}` : ''}`);
      } catch {
        return reply.status(502).send({ error: 'Audio service unavailable' });
      }
    },
  );

  app.post('/api/audio/enroll', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'POST', '/enroll', req.body);
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.post('/api/audio/transcript/correct', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'POST', '/transcript/correct', req.body);
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.post('/api/audio/map-speaker', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'POST', '/map-speaker', req.body);
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.post('/api/audio/advisory-mode', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'POST', '/advisory-mode', req.body);
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.post('/api/audio/talking-points', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'POST', '/talking-points', req.body);
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.post('/api/audio/advisory-dnd', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'POST', '/advisory-dnd');
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.post('/api/audio/pause', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    const lease = getActiveLease();
    if (!lease) return reply.status(409).send({ error: 'No audio capture lease is owned by this runtime' });
    try {
      return await proxyJson(reply, 'POST', '/pause', { lease_token: lease.token });
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.post('/api/audio/resume', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    const lease = getActiveLease();
    if (!lease) return reply.status(409).send({ error: 'No audio capture lease is owned by this runtime' });
    try {
      return await proxyJson(reply, 'POST', '/resume', { lease_token: lease.token });
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.get('/api/audio/sources', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'GET', '/sources');
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.get('/api/audio/events', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    const upstreamAbort = new AbortController();
    let clientClosed = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const closeUpstream = () => {
      if (clientClosed) return;
      clientClosed = true;
      upstreamAbort.abort();
      void reader?.cancel().catch(() => undefined);
    };
    const closeOnRequestAbort = () => {
      if (req.raw.aborted) closeUpstream();
    };
    const closeOnResponseClose = () => {
      if (!reply.raw.writableEnded) closeUpstream();
    };
    req.raw.once('close', closeOnRequestAbort);
    reply.raw.once('close', closeOnResponseClose);
    try {
      const resp = await fetch(`${resolveAudioServiceUrl()}/events`, { signal: upstreamAbort.signal });
      if (clientClosed) return;
      if (!resp.ok || !resp.body) {
        return reply.status(502).send({ error: 'Audio service SSE unavailable' });
      }
      const origin = req.headers.origin;
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        ...(origin && {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
        }),
      });
      reader = resp.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (reply.raw.destroyed || reply.raw.writableEnded) break;
          reply.raw.write(decoder.decode(value, { stream: true }));
        }
      } catch {
        // stream ended or client disconnected
      } finally {
        if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      }
    } catch {
      if (clientClosed) return;
      return reply.status(502).send({ error: 'Audio service unavailable' });
    } finally {
      req.raw.off('close', closeOnRequestAbort);
      reply.raw.off('close', closeOnResponseClose);
    }
  });
};
