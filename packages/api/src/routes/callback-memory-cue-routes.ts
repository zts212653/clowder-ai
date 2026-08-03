import { createHash } from 'node:crypto';
import type { RecallScopeV1 } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  MemoryCueDrillCoordinate,
  MemoryCueDrillHandleService,
} from '../domains/memory/cue/MemoryCueDrillHandleService.js';
import {
  MemoryCueEpisodeStore,
  MemoryCueInvalidatedError,
  type MemoryCueInvalidationReason,
  MemoryCuePresentationRequiredError,
} from '../domains/memory/cue/MemoryCueEpisodeStore.js';
import type { MemoryCueSourceReader } from '../domains/memory/cue/MemoryCueSourceReader.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';

const drillBodySchema = z
  .object({
    handle: z.string().trim().min(1).max(2_000),
    requestId: z.string().trim().min(1).max(200),
  })
  .strict();

const outcomeBodySchema = z
  .object({
    handle: z.string().trim().min(1).max(2_000),
    outcome: z.enum(['applied', 'dismissed']),
    requestId: z.string().trim().min(1).max(200),
  })
  .strict();

export interface CallbackMemoryCueDeps {
  episodeStore: MemoryCueEpisodeStore;
  handles: MemoryCueDrillHandleService;
  sourceReader: MemoryCueSourceReader;
  now: () => number;
}

function invalid(reply: FastifyReply, error: z.ZodError): void {
  reply.status(400).send({ error: 'invalid_request', details: error.issues });
}

function eventHash(...parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 40);
}

function eventBase(coordinate: MemoryCueDrillCoordinate, occurredAt: number) {
  return {
    cueId: coordinate.cueId,
    opportunityId: coordinate.opportunityId,
    scope: coordinate.scope,
    resolverFamily: coordinate.resolverFamily,
    sourceAnchor: coordinate.anchor,
    sourceRevision: coordinate.revision,
    catalogVersion: coordinate.catalogVersion,
    resolverVersion: coordinate.resolverVersion,
    occurredAt,
  };
}

function appendInvalidation(
  store: MemoryCueEpisodeStore,
  coordinate: MemoryCueDrillCoordinate,
  reason: MemoryCueInvalidationReason,
  occurredAt: number,
): void {
  const digest = eventHash('invalidation', coordinate.cueId, reason);
  store.append({
    ...eventBase(coordinate, occurredAt),
    eventId: `memory-cue-invalidation-${digest}`,
    idempotencyKey: `memory-cue-invalidation-${digest}`,
    axis: 'invalidation',
    invalidationReason: reason,
  });
}

function appendConsumption(
  store: MemoryCueEpisodeStore,
  coordinate: MemoryCueDrillCoordinate,
  outcome: 'drilled' | 'applied' | 'dismissed',
  requestId: string,
  occurredAt: number,
): void {
  const digest = eventHash('consumption', coordinate.cueId, outcome, requestId);
  store.append({
    ...eventBase(coordinate, occurredAt),
    eventId: `memory-cue-consumption-${digest}`,
    idempotencyKey: `memory-cue-consumption-${digest}`,
    axis: 'consumption',
    consumptionOutcome: outcome,
  });
}

function serverScope(auth: { userId: string; threadId: string; invocationId: string }): RecallScopeV1 {
  return {
    ownerUserId: auth.userId,
    threadId: auth.threadId,
    invocationId: auth.invocationId,
  };
}

function replyLedgerConflict(reply: FastifyReply, error: unknown): boolean {
  if (error instanceof MemoryCuePresentationRequiredError) {
    reply.status(409).send({ error: 'presentation_required' });
    return true;
  }
  if (error instanceof MemoryCueInvalidatedError) {
    reply.status(409).send({ error: 'cue_invalidated' });
    return true;
  }
  return false;
}

function appendConsumptionOrReply(
  deps: CallbackMemoryCueDeps,
  coordinate: MemoryCueDrillCoordinate,
  outcome: 'drilled' | 'applied' | 'dismissed',
  requestId: string,
  now: number,
  reply: FastifyReply,
): boolean {
  try {
    appendConsumption(deps.episodeStore, coordinate, outcome, requestId, now);
    return true;
  } catch (error) {
    if (replyLedgerConflict(reply, error)) return false;
    throw error;
  }
}

function verifyCoordinate(
  deps: CallbackMemoryCueDeps,
  handle: string,
  scope: RecallScopeV1,
  now: number,
  reply: FastifyReply,
): MemoryCueDrillCoordinate | null {
  const verified = deps.handles.verify(handle, scope, now);
  if (verified.ok) return verified.coordinate;
  if (verified.reason === 'expired') {
    appendInvalidation(deps.episodeStore, verified.coordinate, 'expired', now);
    reply.status(410).send({ error: 'expired' });
    return null;
  }
  if (verified.reason === 'presentation_required') {
    reply.status(409).send({ error: 'presentation_required' });
    return null;
  }
  reply.status(404).send({ error: 'not_available' });
  return null;
}

async function readCurrentSource(
  deps: CallbackMemoryCueDeps,
  coordinate: MemoryCueDrillCoordinate,
  now: number,
  reply: FastifyReply,
): Promise<{ status: 'ok'; payload: unknown } | null> {
  let source: Awaited<ReturnType<MemoryCueSourceReader['read']>>;
  try {
    source = await deps.sourceReader.read({
      family: coordinate.family,
      anchor: coordinate.anchor,
      expectedRevision: coordinate.revision,
      scope: coordinate.scope,
    });
  } catch {
    reply.status(404).send({ error: 'not_available' });
    return null;
  }
  if (source.status === 'ok') return source;
  if (source.invalidationReason) {
    appendInvalidation(deps.episodeStore, coordinate, source.invalidationReason, now);
  }
  reply.status(404).send({ error: 'not_available' });
  return null;
}

export function registerCallbackMemoryCueRoutes(app: FastifyInstance, deps: CallbackMemoryCueDeps): void {
  app.post('/api/callbacks/memory-cues/drill', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const body = drillBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const now = deps.now();
    const coordinate = verifyCoordinate(deps, body.data.handle, serverScope(auth), now, reply);
    if (!coordinate) return;
    const source = await readCurrentSource(deps, coordinate, now, reply);
    if (!source) return;
    if (!appendConsumptionOrReply(deps, coordinate, 'drilled', body.data.requestId, now, reply)) return;
    return { status: 'ok', payload: source.payload };
  });

  app.post('/api/callbacks/memory-cues/outcome', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const body = outcomeBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const now = deps.now();
    const coordinate = verifyCoordinate(deps, body.data.handle, serverScope(auth), now, reply);
    if (!coordinate) return;
    if (!appendConsumptionOrReply(deps, coordinate, body.data.outcome, body.data.requestId, now, reply)) return;
    return { status: 'recorded', outcome: body.data.outcome };
  });
}
