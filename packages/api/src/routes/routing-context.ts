import {
  routingPreferenceCreateCommandV1Schema,
  routingPreferenceRetireCommandV1Schema,
  routingPreferenceSupersedeCommandV1Schema,
  routingSignalCloseCommandV1Schema,
  routingSignalMarkCommandV1Schema,
} from '@cat-cafe/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import {
  RoutingContextCommandError,
  RoutingContextCommandService,
  type RoutingContextIdKind,
} from '../domains/routing-context/RoutingContextCommandService.js';
import type { RoutingContextReadService } from '../domains/routing-context/RoutingContextReadService.js';
import type { IRoutingPreferenceStore } from '../domains/routing-context/RoutingPreferenceStore.js';
import type { IRoutingSignalEventStore } from '../domains/routing-context/RoutingSignalEventStore.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

export interface RoutingContextRouteRuntime {
  readService: Pick<RoutingContextReadService, 'read'>;
  signalStore: Pick<IRoutingSignalEventStore, 'append' | 'get' | 'getByCommand'>;
  preferenceStore: Pick<IRoutingPreferenceStore, 'append' | 'getHead' | 'getByCommand'>;
  now?: () => number;
  nextId?: (kind: RoutingContextIdKind) => string;
}

export interface RoutingContextRoutesOptions {
  runtime?: RoutingContextRouteRuntime;
}

function requireOwner(request: FastifyRequest, reply: FastifyReply): string | undefined {
  const userId = resolveStrictUserId(request);
  if (!userId) {
    reply.status(401).send({ error: 'Session required' });
    return undefined;
  }
  const ownerError = resolveOwnerGate(userId, {
    errorMessage: 'Routing context may only be changed or read by the configured owner',
  });
  if (ownerError) {
    reply.status(ownerError.status).send({ error: ownerError.error });
    return undefined;
  }
  return userId;
}

function requireRuntime(
  runtime: RoutingContextRouteRuntime | undefined,
  reply: FastifyReply,
): RoutingContextRouteRuntime | undefined {
  if (!runtime) reply.status(503).send({ error: 'Routing context persistence is unavailable' });
  return runtime;
}

function isNamedError(error: unknown, names: readonly string[]): boolean {
  return error instanceof Error && names.includes(error.name);
}

function mapRoutingError(error: unknown, reply: FastifyReply) {
  if (error instanceof RoutingContextCommandError) {
    const status = error.code === 'not_found' ? 404 : error.code === 'conflict' ? 409 : 400;
    return reply.status(status).send({ error: error.message });
  }
  if (isNamedError(error, ['RoutingSignalEventConflictError', 'RoutingPreferenceConflictError'])) {
    return reply.status(409).send({ error: error instanceof Error ? error.message : String(error) });
  }
  if (isNamedError(error, ['RoutingSignalEventHydrationError', 'RoutingPreferenceHydrationError'])) {
    return reply.status(503).send({ error: 'Routing context persistence is unavailable' });
  }
  if (isNamedError(error, ['ZodError'])) {
    return reply.status(400).send({
      error: 'Invalid routing context command',
      details: error instanceof Error && 'issues' in error ? error.issues : undefined,
    });
  }
  return reply.status(500).send({ error: 'Routing context operation failed' });
}

async function sendCommand<T>(command: Promise<T>, reply: FastifyReply) {
  try {
    return reply.status(201).send(await command);
  } catch (error) {
    return mapRoutingError(error, reply);
  }
}

export const routingContextRoutes: FastifyPluginAsync<RoutingContextRoutesOptions> = async (app, options) => {
  const now = options.runtime?.now ?? (() => Date.now());
  const commands = options.runtime
    ? new RoutingContextCommandService({
        signalStore: options.runtime.signalStore,
        preferenceStore: options.runtime.preferenceStore,
        now,
        ...(options.runtime.nextId ? { nextId: options.runtime.nextId } : {}),
      })
    : undefined;

  app.get('/api/routing-context/snapshot', async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    const runtime = requireRuntime(options.runtime, reply);
    if (!runtime) return;
    const query = request.query as { intent?: string; targetCatIds?: string };
    if (query.intent !== undefined && query.intent !== 'review' && query.intent !== 'architecture') {
      return reply.status(400).send({ error: 'Invalid routing context intent' });
    }
    const targetCatIds = query.targetCatIds
      ?.split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    try {
      return await runtime.readService.read({
        ownerId,
        observedAt: now(),
        ...(query.intent ? { intent: query.intent } : {}),
        ...(targetCatIds?.length ? { targetCatIds } : {}),
      });
    } catch (error) {
      app.log.warn({ err: error }, 'F293 routing context read failed');
      return reply.status(503).send({ error: 'Routing context persistence is unavailable' });
    }
  });

  app.get('/api/routing-context/preferences', async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    const runtime = requireRuntime(options.runtime, reply);
    if (!runtime) return;
    try {
      const model = await runtime.readService.read({ ownerId, observedAt: now() });
      return { preferenceRevisions: model.preferenceRevisions };
    } catch (error) {
      app.log.warn({ err: error }, 'F293 routing preference read failed');
      return reply.status(503).send({ error: 'Routing context persistence is unavailable' });
    }
  });

  app.post('/api/routing-context/signals', async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    if (!requireRuntime(options.runtime, reply) || !commands) return;
    const parsed = routingSignalMarkCommandV1Schema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'Invalid routing signal command', details: parsed.error.issues });
    return sendCommand(commands.mark(ownerId, parsed.data), reply);
  });

  async function closeSignal(request: FastifyRequest, reply: FastifyReply, eventType: 'recovered' | 'retracted') {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    if (!requireRuntime(options.runtime, reply) || !commands) return;
    const parsed = routingSignalCloseCommandV1Schema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'Invalid routing signal command', details: parsed.error.issues });
    const { id } = request.params as { id: string };
    return sendCommand(commands.close(ownerId, id, parsed.data, eventType), reply);
  }

  app.post('/api/routing-context/signals/:id/recover', (request, reply) => closeSignal(request, reply, 'recovered'));
  app.post('/api/routing-context/signals/:id/retract', (request, reply) => closeSignal(request, reply, 'retracted'));

  app.post('/api/routing-context/preferences', async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    if (!requireRuntime(options.runtime, reply) || !commands) return;
    const parsed = routingPreferenceCreateCommandV1Schema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'Invalid routing preference command', details: parsed.error.issues });
    return sendCommand(commands.createPreference(ownerId, parsed.data), reply);
  });

  async function supersedePreference(request: FastifyRequest, reply: FastifyReply) {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    if (!requireRuntime(options.runtime, reply) || !commands) return;
    const parsed = routingPreferenceSupersedeCommandV1Schema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'Invalid routing preference command', details: parsed.error.issues });
    const { id } = request.params as { id: string };
    return sendCommand(commands.supersedePreference(ownerId, id, parsed.data), reply);
  }

  app.post('/api/routing-context/preferences/:id/supersede', supersedePreference);
  app.post('/api/routing-context/preferences/:id/renew', supersedePreference);

  app.post('/api/routing-context/preferences/:id/retire', async (request, reply) => {
    const ownerId = requireOwner(request, reply);
    if (!ownerId) return;
    if (!requireRuntime(options.runtime, reply) || !commands) return;
    const parsed = routingPreferenceRetireCommandV1Schema.safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({ error: 'Invalid routing preference command', details: parsed.error.issues });
    const { id } = request.params as { id: string };
    return sendCommand(commands.retirePreference(ownerId, id, parsed.data), reply);
  });
};
