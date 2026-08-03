import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { BleDeviceManager } from '../domains/limb/ble/BleDeviceManager.js';
import { isDirectLoopbackRequest } from '../utils/loopback-request.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';

export interface BleRoutesOptions {
  manager: BleDeviceManager | null;
  platform?: string;
  unavailableReason?: string;
}

const bindSchema = z
  .object({
    sessionId: z.string().min(1).max(128),
    discoveryId: z.string().min(1).max(128),
  })
  .strict();

const bindingParamsSchema = z.object({ bindingId: z.string().min(1).max(128) }).strict();

function sessionUserId(request: FastifyRequest): string | null {
  const userId = (request as FastifyRequest & { sessionUserId?: string }).sessionUserId;
  return typeof userId === 'string' && userId.trim() ? userId.trim() : null;
}

function requireReadIdentity(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = sessionUserId(request);
  if (!userId) {
    reply.status(401).send({ error: 'Authentication required' });
    return null;
  }
  return userId;
}

function requireWriteIdentity(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = sessionUserId(request);
  if (!userId) {
    reply.status(401).send({ error: 'Authentication required' });
    return null;
  }
  if (!isDirectLoopbackRequest(request) && !process.env.DEFAULT_OWNER_USER_ID?.trim()) {
    reply.status(403).send({
      error: 'BLE device changes from non-localhost require DEFAULT_OWNER_USER_ID to be configured',
    });
    return null;
  }
  const ownerError = resolveOwnerGate(userId, {
    errorMessage: 'BLE device changes can only be performed by the configured owner',
  });
  if (ownerError) {
    reply.status(ownerError.status).send({ error: ownerError.error });
    return null;
  }
  return userId;
}

function unavailable(reply: FastifyReply): void {
  reply.status(503).send({ error: 'BLE binding storage is unavailable' });
}

function errorStatus(error: Error): number {
  if (
    error.message.includes('already active') ||
    error.message.includes('already bound') ||
    error.message.includes('already in progress')
  )
    return 409;
  if (
    error.message.includes('not available') ||
    error.message.includes('not expose') ||
    error.message.includes('not compatible')
  )
    return 422;
  if (error.message.includes('timed out')) return 504;
  if (error.message.includes('unsupported') || error.message.includes('unavailable')) return 503;
  return 502;
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'BLE operation failed';
  return message.slice(0, 512);
}

export function registerBleRoutes(app: FastifyInstance, options: BleRoutesOptions): void {
  const platform = options.platform ?? process.platform;
  const unavailableReason =
    options.unavailableReason ??
    (platform === 'darwin'
      ? 'Redis is required for persistent BLE bindings'
      : 'BLE helper is only available on macOS in Phase A');

  app.get('/api/limb/ble/status', async (request, reply) => {
    if (!requireReadIdentity(request, reply)) return;
    if (options.manager) return reply.send(options.manager.status());
    return reply.send({
      platform,
      available: false,
      state: platform === 'darwin' ? 'degraded' : 'unsupported',
      reason: unavailableReason,
      restartAttempts: 0,
      bindingCount: 0,
    });
  });

  app.get('/api/limb/ble/bindings', async (request, reply) => {
    if (!requireReadIdentity(request, reply)) return;
    if (!options.manager) return unavailable(reply);
    return reply.send({ bindings: await options.manager.listBindings() });
  });

  app.get('/api/limb/ble/scan', async (request, reply) => {
    if (!requireReadIdentity(request, reply)) return;
    if (!options.manager) return unavailable(reply);
    return reply.send(options.manager.scanSnapshot());
  });

  app.post('/api/limb/ble/scan', async (request, reply) => {
    if (!requireWriteIdentity(request, reply)) return;
    if (!options.manager) return unavailable(reply);
    try {
      return reply.status(201).send(await options.manager.startScan());
    } catch (error) {
      const message = safeError(error);
      return reply.status(errorStatus(new Error(message))).send({ error: message });
    }
  });

  app.delete('/api/limb/ble/scan', async (request, reply) => {
    if (!requireWriteIdentity(request, reply)) return;
    if (!options.manager) return unavailable(reply);
    await options.manager.stopScan();
    return reply.status(204).send();
  });

  app.post('/api/limb/ble/bindings', async (request, reply) => {
    if (!requireWriteIdentity(request, reply)) return;
    if (!options.manager) return unavailable(reply);
    const parsed = bindSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      return reply.status(201).send(await options.manager.bind(parsed.data));
    } catch (error) {
      const message = safeError(error);
      return reply.status(errorStatus(new Error(message))).send({ error: message });
    }
  });

  app.post('/api/limb/ble/bindings/:bindingId/probe', async (request, reply) => {
    if (!requireWriteIdentity(request, reply)) return;
    if (!options.manager) return unavailable(reply);
    const params = bindingParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: params.error.message });
    try {
      const result = await options.manager.probeBinding(params.data.bindingId);
      if (!result) return reply.status(404).send({ error: 'BLE binding not found' });
      return reply.send(result);
    } catch (error) {
      const message = safeError(error);
      return reply.status(errorStatus(new Error(message))).send({ error: message });
    }
  });

  app.post('/api/limb/ble/bindings/:bindingId/rebind', async (request, reply) => {
    if (!requireWriteIdentity(request, reply)) return;
    if (!options.manager) return unavailable(reply);
    const params = bindingParamsSchema.safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: params.error.message });
    const body = bindSchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: body.error.message });
    try {
      const binding = await options.manager.rebindBinding(params.data.bindingId, body.data);
      if (!binding) return reply.status(404).send({ error: 'BLE binding not found' });
      return reply.send(binding);
    } catch (error) {
      const message = safeError(error);
      return reply.status(errorStatus(new Error(message))).send({ error: message });
    }
  });

  app.delete('/api/limb/ble/bindings/:bindingId', async (request, reply) => {
    if (!requireWriteIdentity(request, reply)) return;
    if (!options.manager) return unavailable(reply);
    const parsed = bindingParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const removed = await options.manager.unbind(parsed.data.bindingId);
    if (!removed) return reply.status(404).send({ error: 'BLE binding not found' });
    return reply.status(204).send();
  });
}
