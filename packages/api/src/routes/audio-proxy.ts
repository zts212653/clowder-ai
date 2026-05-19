/**
 * F195 Phase B — Audio proxy routes.
 *
 * Proxies frontend requests to the standalone Python audio-service (:9881).
 * The frontend cannot hit localhost:9881 directly (CORS / deployment boundary).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { resolveUserId } from '../utils/request-identity.js';

const AUDIO_URL = process.env['AUDIO_SERVICE_URL'] ?? 'http://127.0.0.1:9881';

function requireIdentity(request: FastifyRequest, reply: FastifyReply): boolean {
  const userId = resolveUserId(request, {});
  if (!userId) {
    reply.status(401).send({ error: 'Identity required' });
    return false;
  }
  return true;
}

async function proxyJson(reply: FastifyReply, method: string, path: string, body?: unknown): Promise<void> {
  const resp = await fetch(`${AUDIO_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json();
  return reply.status(resp.status).send(data);
}

export const audioProxyRoutes: FastifyPluginAsync = async (app) => {
  app.post('/api/audio/start', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'POST', '/start', req.body);
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.post('/api/audio/stop', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'POST', '/stop');
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
    try {
      return await proxyJson(reply, 'POST', '/pause');
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });

  app.post('/api/audio/resume', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    try {
      return await proxyJson(reply, 'POST', '/resume');
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
    try {
      const resp = await fetch(`${AUDIO_URL}/events`);
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
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      req.raw.on('close', () => reader.cancel());
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          reply.raw.write(decoder.decode(value, { stream: true }));
        }
      } catch {
        // stream ended or client disconnected
      } finally {
        reply.raw.end();
      }
    } catch {
      return reply.status(502).send({ error: 'Audio service unavailable' });
    }
  });
};
