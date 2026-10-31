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
import { guardedAudioStopError } from './audio-capture-target.js';
import { AudioCaptureController, audioCaptureFinalized, CONTROLLER_LEASE_TTL_S } from './audio-controller-lease.js';
import { registerAudioEventProxy } from './audio-event-proxy.js';
import { AUDIO_MUTATION_TIMEOUT_MS, audioRequestFailure, requestAudioJson } from './audio-request-deadline.js';

export function resolveAudioServiceUrl(): string {
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

function captureBody(body: unknown): Record<string, unknown> | null {
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

export const audioProxyRoutes: FastifyPluginAsync<{ requestTimeoutMs?: number }> = async (app, options) => {
  const controller = new AudioCaptureController(resolveAudioServiceUrl, app.log);
  const getActiveLease = () => controller.activeLease();
  app.addHook('onClose', async () => controller.close());

  app.post('/api/audio/start', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    const body = captureBody(req.body);
    const threadId = body?.thread_id;
    if (typeof threadId !== 'string' || !threadId.trim()) {
      return reply.status(400).send({ error: 'thread_id is required for active audio capture' });
    }
    if (controller.expired()) {
      const before = controller.snapshot();
      try {
        const observed = await requestAudioJson(
          req,
          `${resolveAudioServiceUrl()}/status`,
          'GET',
          undefined,
          options.requestTimeoutMs,
        );
        if (observed.ok) controller.observe(observed.data, before);
      } catch (error) {
        return audioRequestFailure(reply, error);
      }
    }
    const meetingId =
      typeof body?.meeting_id === 'string' && body.meeting_id
        ? body.meeting_id
        : `mtg-${randomUUID().replaceAll('-', '')}`;
    const intent = controller.reserve(threadId.trim(), meetingId);
    if (!intent) {
      return reply.status(409).send({ error: 'Audio capture is already owned by this runtime' });
    }
    try {
      const result = await requestAudioJson(
        req,
        `${resolveAudioServiceUrl()}/start`,
        'POST',
        {
          ...body,
          thread_id: threadId.trim(),
          meeting_id: meetingId,
          controller_id: intent.controllerId,
          lease_ttl_s: CONTROLLER_LEASE_TTL_S,
        },
        options.requestTimeoutMs ?? AUDIO_MUTATION_TIMEOUT_MS,
        false,
      );
      const data = result.data as Record<string, unknown>;
      if (!result.ok) {
        controller.rejected(intent);
        return reply.status(result.status).send(data);
      }
      if (!controller.accepted(intent, data)) {
        return reply.status(502).send({ error: 'Audio service start omitted controller lease token' });
      }
      const clientData = { ...data };
      delete clientData.lease_token;
      return reply.send(clientData);
    } catch (error) {
      return audioRequestFailure(reply, error);
    } finally {
      controller.settled(intent);
    }
  });

  app.post('/api/audio/stop', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    const lease = getActiveLease();
    if (!lease) {
      return reply.status(409).send({ error: 'No audio capture lease is owned by this runtime' });
    }
    const targetError = guardedAudioStopError(captureBody(req.body), lease.target);
    if (targetError) return reply.status(targetError.status).send({ error: targetError.error });
    try {
      const result = await requestAudioJson(
        req,
        `${resolveAudioServiceUrl()}/stop`,
        'POST',
        { lease_token: lease.token, reason: 'controller-stop' },
        options.requestTimeoutMs ?? AUDIO_MUTATION_TIMEOUT_MS,
        false,
      );
      if (result.ok) {
        const status = captureBody(result.data)?.status;
        if (!audioCaptureFinalized(status))
          return reply.status(503).send({ error: 'Audio capture finalization unconfirmed' });
        controller.release(lease);
      }
      return reply.status(result.status).send(result.data);
    } catch (error) {
      return audioRequestFailure(reply, error);
    }
  });

  app.get('/api/audio/status', async (req, reply) => {
    if (!requireIdentity(req, reply)) return;
    const before = controller.snapshot();
    try {
      const result = await requestAudioJson(
        req,
        `${resolveAudioServiceUrl()}/status`,
        'GET',
        undefined,
        options.requestTimeoutMs,
      );
      if (result.ok) controller.observe(result.data, before);
      return reply.code(result.status).send(controller.status(result.data));
    } catch (error) {
      return audioRequestFailure(reply, error);
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
      const result = await requestAudioJson(
        req,
        `${resolveAudioServiceUrl()}/sources`,
        'GET',
        undefined,
        options.requestTimeoutMs,
      );
      return reply.code(result.status).send(result.data);
    } catch (error) {
      return audioRequestFailure(reply, error);
    }
  });

  registerAudioEventProxy(app, { requireIdentity, resolveServiceUrl: resolveAudioServiceUrl });
};
