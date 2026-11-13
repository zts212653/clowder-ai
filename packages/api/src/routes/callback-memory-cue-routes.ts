import { createHash } from 'node:crypto';
import {
  type MemoryCueDocumentWindowRequest,
  memoryCueDocumentWindowRequestSchema,
  type OwnerTruthRefV1,
  ownerTruthRefV1Schema,
  type RecallScopeV1,
} from '@cat-cafe/shared';
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
  type MemoryCueEvent,
  MemoryCueInvalidatedError,
  type MemoryCueInvalidationReason,
  MemoryCuePresentationRequiredError,
  memoryCueConsumptionIdempotencyKey,
} from '../domains/memory/cue/MemoryCueEpisodeStore.js';
import {
  type CurrentMemoryCueSource,
  readMemoryCueCurrentSource,
  resolveMemoryCueOutcomeSettlement,
} from '../domains/memory/cue/MemoryCueOutcomeSettlement.js';
import type { MemoryCueSourceReader } from '../domains/memory/cue/MemoryCueSourceReader.js';
import { catOwnedSeedDrillPayloadSchema } from '../domains/memory/cue/sources/CatOwnedSeedMemoryCueSource.js';
import { TASTE_TASK_BUNDLE_SOURCE_ANCHOR_PREFIX } from '../domains/memory/cue/TasteTaskBundleCatalog.js';
import { requireCallbackAuth } from './callback-auth-prehandler.js';
import { memoryCueOutcomeReadyOrReply } from './callback-memory-cue-outcome-response.js';
import { registerCallbackWorkPreparation, type WorkPreparationCallback } from './callback-work-preparation.js';

const drillBodySchema = z
  .object({
    handle: z.string().trim().min(1).max(2_000),
    requestId: z.string().trim().min(1).max(200),
    window: memoryCueDocumentWindowRequestSchema.optional(),
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
  preparation?: WorkPreparationCallback;
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
  deps: CallbackMemoryCueDeps,
  coordinate: MemoryCueDrillCoordinate,
  reason: MemoryCueInvalidationReason,
  occurredAt: number,
): void {
  if (coordinate.opportunityId.startsWith('preparation-')) {
    deps.preparation?.recordInvalidation(coordinate, reason, occurredAt);
    return;
  }
  const digest = eventHash('invalidation', coordinate.cueId, reason);
  deps.episodeStore.append({
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
): MemoryCueEvent {
  const idempotencyKey = memoryCueConsumptionIdempotencyKey(coordinate.cueId, outcome, requestId);
  return store.append({
    ...eventBase(coordinate, occurredAt),
    eventId: idempotencyKey,
    idempotencyKey,
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
): MemoryCueEvent | null {
  try {
    return appendConsumption(deps.episodeStore, coordinate, outcome, requestId, now);
  } catch (error) {
    if (replyLedgerConflict(reply, error)) return null;
    throw error;
  }
}

function memoryCueOutcomeRef(event: MemoryCueEvent): OwnerTruthRefV1 {
  return ownerTruthRefV1Schema.parse({
    ownerFeatureId: 'F287',
    ownerStateRef: `memory-cue-consumption:${event.eventId}`,
    version: event.createdAt,
  });
}

function verifyCoordinate(
  deps: CallbackMemoryCueDeps,
  handle: string,
  scope: RecallScopeV1,
  catId: string,
  now: number,
  reply: FastifyReply,
  explicitPreparationRead = false,
): MemoryCueDrillCoordinate | null {
  let verified = deps.handles.verify(handle, scope, now, catId);
  if (!verified.ok && verified.reason === 'presentation_required' && explicitPreparationRead)
    verified = deps.handles.verifyPreparationRead(handle, scope, now, catId);
  if (verified.ok) return verified.coordinate;
  if (verified.reason === 'expired') {
    appendInvalidation(deps, verified.coordinate, 'expired', now);
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
  window?: MemoryCueDocumentWindowRequest,
): Promise<CurrentMemoryCueSource | null> {
  const source = await readMemoryCueCurrentSource(deps.sourceReader, coordinate, consumerCatId, window);
  if (source.status === 'source_read_failed') {
    reply.status(503).send({ error: 'source_read_failed', retryable: true });
    return null;
  }
  if (source.status === 'ok') return source;
  if (source.invalidationReason) {
    appendInvalidation(deps, coordinate, source.invalidationReason, now);
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
  currentSource?: CurrentMemoryCueSource;
}): Promise<boolean> {
  const { coordinate, deps, outcome, requestId, auth, now, reply, currentSource } = input;
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
      idempotencyKey: memoryCueConsumptionIdempotencyKey(coordinate.cueId, outcome, requestId),
      ...(coordinate.consumerCatId ? { consumerCatId: coordinate.consumerCatId } : {}),
    })
  ) {
    return true;
  }
  const source = currentSource ?? (await readCurrentSource(deps, coordinate, auth.catId, now, reply));
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
  registerCallbackWorkPreparation(app, deps.preparation, deps.now);
  app.post('/api/callbacks/memory-cues/drill', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const body = drillBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const now = deps.now();
    const coordinate = verifyCoordinate(
      deps,
      body.data.handle,
      serverScope(auth),
      auth.catId as string,
      now,
      reply,
      true,
    );
    if (!coordinate) return;
    if (
      body.data.window &&
      (coordinate.family !== 'evidence' || !/^(?:project-collection:|F\d{3,}$|ADR-\d{3}$)/.test(coordinate.anchor))
    ) {
      return reply.status(400).send({
        error: 'window_not_supported',
        details: 'window requires a canonical project document cue; omit window for other sources.',
      });
    }
    const source = await readCurrentSource(deps, coordinate, auth.catId as string, now, reply, body.data.window);
    if (!source) return;
    if (coordinate.opportunityId.startsWith('preparation-')) {
      if (!deps.preparation) return reply.code(409).send({ error: 'preparation_read_not_available' });
      try {
        deps.preparation.recordRead(coordinate, body.data.requestId, deps.now());
      } catch (error) {
        if (replyLedgerConflict(reply, error)) return;
        request.log.warn({ err: error, cueId: coordinate.cueId }, 'Preparation read receipt commit failed');
        return reply.code(503).send({ error: 'read_commit_failed', retryable: true });
      }
    } else if (!appendConsumptionOrReply(deps, coordinate, 'drilled', body.data.requestId, now, reply)) return;
    return { status: 'ok', payload: source.payload };
  });

  app.post('/api/callbacks/memory-cues/outcome', async (request, reply) => {
    const auth = requireCallbackAuth(request, reply);
    if (!auth) return;
    const body = outcomeBodySchema.safeParse(request.body);
    if (!body.success) return invalid(reply, body.error);
    const now = deps.now();
    const resolution = await resolveMemoryCueOutcomeSettlement({
      handles: deps.handles,
      episodeStore: deps.episodeStore,
      sourceReader: deps.sourceReader,
      handle: body.data.handle,
      scope: serverScope(auth),
      catId: auth.catId as string,
      outcome: body.data.outcome,
      requestId: body.data.requestId,
      now,
    });
    const ready = memoryCueOutcomeReadyOrReply(resolution, reply, (coordinate, reason) =>
      appendInvalidation(deps, coordinate, reason, now),
    );
    if (!ready) return;
    const { coordinate, currentSource } = ready;
    if (coordinate.family === 'matter') return reply.code(409).send({ error: 'matter_outcome_not_supported' });
    if (
      coordinate.opportunityId.startsWith('preparation-') &&
      !currentSource &&
      !(await readCurrentSource(deps, coordinate, auth.catId as string, now, reply))
    )
      return;
    if (
      !(await verifyApplicationEvidence({
        deps,
        coordinate,
        outcome: body.data.outcome,
        requestId: body.data.requestId,
        auth: { threadId: auth.threadId, catId: auth.catId as string, invocationId: auth.invocationId },
        now,
        reply,
        ...(currentSource ? { currentSource } : {}),
      }))
    )
      return;
    const event = appendConsumptionOrReply(deps, coordinate, body.data.outcome, body.data.requestId, now, reply);
    if (!event) return;
    return {
      status: 'recorded',
      outcome: body.data.outcome,
      outcomeRef: memoryCueOutcomeRef(event),
      ...(ready.settlement ? { settlement: ready.settlement } : {}),
    };
  });
}
