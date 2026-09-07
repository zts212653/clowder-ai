import { createHash } from 'node:crypto';
import type { RecallScopeV1 } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  EXPLICIT_APPROVED_TASTE_SOURCE_ANCHOR_PREFIX,
  explicitApprovedTasteDrillPayloadSchema,
} from '../domains/memory/cue/ExplicitApprovedTasteTriggerCatalog.js';
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
import { catOwnedSeedDrillPayloadSchema } from '../domains/memory/cue/sources/CatOwnedSeedMemoryCueSource.js';
import { TASTE_TASK_BUNDLE_SOURCE_ANCHOR_PREFIX } from '../domains/memory/cue/TasteTaskBundleCatalog.js';
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
  applicationEvidence?: {
    hasRichBlock?(input: { threadId: string; catId: string; invocationId: string; kind: 'html_widget' }): boolean;
    hasOwnedSeedIntent?(input: {
      ownerUserId: string;
      catId: string;
      invocationId: string;
      seedId: string;
    }): boolean | Promise<boolean>;
  };
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
    ...(coordinate.consumerCatId ? { consumerCatId: coordinate.consumerCatId } : {}),
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
  const idempotencyKey = consumptionIdempotencyKey(coordinate.cueId, outcome, requestId);
  store.append({
    ...eventBase(coordinate, occurredAt),
    eventId: idempotencyKey,
    idempotencyKey,
    axis: 'consumption',
    consumptionOutcome: outcome,
  });
}

function consumptionIdempotencyKey(cueId: string, outcome: 'drilled' | 'applied' | 'dismissed', requestId: string) {
  return `memory-cue-consumption-${eventHash('consumption', cueId, outcome, requestId)}`;
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
  catId: string,
  now: number,
  reply: FastifyReply,
): MemoryCueDrillCoordinate | null {
  const verified = deps.handles.verify(handle, scope, now, catId);
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
  consumerCatId: string,
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
      consumerCatId,
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

async function verifyApplicationEvidence(input: {
  deps: CallbackMemoryCueDeps;
  coordinate: MemoryCueDrillCoordinate;
  outcome: 'applied' | 'dismissed';
  requestId: string;
  auth: { threadId: string; catId: string; invocationId: string };
  now: number;
  reply: FastifyReply;
}): Promise<boolean> {
  const { coordinate, deps, outcome, requestId, auth, now, reply } = input;
  if (outcome !== 'applied') {
    return true;
  }
  const requiresExplicitTasteEvidence =
    coordinate.family === 'taste' && coordinate.anchor.startsWith(EXPLICIT_APPROVED_TASTE_SOURCE_ANCHOR_PREFIX);
  const requiresTaskBundleEvidence =
    coordinate.family === 'taste' && coordinate.anchor.startsWith(TASTE_TASK_BUNDLE_SOURCE_ANCHOR_PREFIX);
  const requiresOwnedSeedEvidence = coordinate.family === 'owned_seed';
  if (!requiresExplicitTasteEvidence && !requiresTaskBundleEvidence && !requiresOwnedSeedEvidence) return true;
  if (
    deps.episodeStore.hasExactConsumptionRequest({
      scope: coordinate.scope,
      cueId: coordinate.cueId,
      outcome,
      idempotencyKey: consumptionIdempotencyKey(coordinate.cueId, outcome, requestId),
      ...(coordinate.consumerCatId ? { consumerCatId: coordinate.consumerCatId } : {}),
    })
  ) {
    return true;
  }
  const source = await readCurrentSource(deps, coordinate, auth.catId, now, reply);
  if (!source) return false;
  const hasDrilled = deps.episodeStore.hasConsumptionOutcome(
    coordinate.scope,
    coordinate.cueId,
    'drilled',
    coordinate.consumerCatId,
  );
  if (requiresTaskBundleEvidence && hasDrilled) return true;
  if (requiresExplicitTasteEvidence) {
    const payload = explicitApprovedTasteDrillPayloadSchema.safeParse(source.payload);
    const hasRichBlock = payload.success
      ? (deps.applicationEvidence?.hasRichBlock?.({
          threadId: auth.threadId,
          catId: auth.catId,
          invocationId: auth.invocationId,
          kind: payload.data.applicationContract.requiredRichBlockKind,
        }) ?? false)
      : false;
    if (payload.success && hasDrilled && hasRichBlock) return true;
  }
  if (requiresOwnedSeedEvidence) {
    const payload = catOwnedSeedDrillPayloadSchema.safeParse(source.payload);
    const hasIntent = payload.success
      ? ((await deps.applicationEvidence?.hasOwnedSeedIntent?.({
          ownerUserId: coordinate.scope.ownerUserId,
          catId: auth.catId,
          invocationId: auth.invocationId,
          seedId: payload.data.seedId,
        })) ?? false)
      : false;
    if (payload.success && hasDrilled && hasIntent) return true;
  }
  reply.status(409).send({ error: 'application_evidence_required' });
  return false;
}

export function registerCallbackMemoryCueRoutes(app: FastifyInstance, deps: CallbackMemoryCueDeps): void {
  app.post('/api/callbacks/memory-cues/drill', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const body = drillBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const now = deps.now();
    const coordinate = verifyCoordinate(deps, body.data.handle, serverScope(auth), auth.catId as string, now, reply);
    if (!coordinate) return;
    const source = await readCurrentSource(deps, coordinate, auth.catId as string, now, reply);
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
    const coordinate = verifyCoordinate(deps, body.data.handle, serverScope(auth), auth.catId as string, now, reply);
    if (!coordinate) return;
    if (
      !(await verifyApplicationEvidence({
        deps,
        coordinate,
        outcome: body.data.outcome,
        requestId: body.data.requestId,
        auth: { threadId: auth.threadId, catId: auth.catId as string, invocationId: auth.invocationId },
        now,
        reply,
      }))
    )
      return;
    if (!appendConsumptionOrReply(deps, coordinate, body.data.outcome, body.data.requestId, now, reply)) return;
    return { status: 'recorded', outcome: body.data.outcome };
  });
}
