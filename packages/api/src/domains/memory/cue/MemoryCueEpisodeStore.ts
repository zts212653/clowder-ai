import {
  RECALL_OPPORTUNITY_CATALOG_VERSION,
  RECALL_RESOLVER_FAMILIES,
  type RecallResolverFamily,
  type RecallScopeV1,
  recallScopeV1Schema,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { MemoryCueDrillCoordinate } from './MemoryCueDrillHandleService.js';

export const MEMORY_CUE_CONSUMPTION_OUTCOMES = ['presented', 'drilled', 'applied', 'dismissed'] as const;

export const MEMORY_CUE_INVALIDATION_REASONS = [
  'source_corrected',
  'source_forgotten',
  'scope_revoked',
  'superseded',
  'expired',
] as const;

const identifierSchema = z.string().trim().min(1).max(500);
const eventBaseShape = {
  eventId: identifierSchema,
  idempotencyKey: identifierSchema,
  cueId: identifierSchema,
  opportunityId: identifierSchema,
  scope: recallScopeV1Schema,
  resolverFamily: z.enum(RECALL_RESOLVER_FAMILIES),
  sourceAnchor: identifierSchema,
  sourceRevision: identifierSchema,
  catalogVersion: z.number().int().positive(),
  resolverVersion: z.number().int().positive(),
  occurredAt: z.number().int().nonnegative().finite(),
};

const consumptionEventInputSchema = z
  .object({
    ...eventBaseShape,
    axis: z.literal('consumption'),
    consumptionOutcome: z.enum(MEMORY_CUE_CONSUMPTION_OUTCOMES),
  })
  .strict();

const invalidationEventInputSchema = z
  .object({
    ...eventBaseShape,
    axis: z.literal('invalidation'),
    invalidationReason: z.enum(MEMORY_CUE_INVALIDATION_REASONS),
  })
  .strict();

export const memoryCueEventInputSchema = z.discriminatedUnion('axis', [
  consumptionEventInputSchema,
  invalidationEventInputSchema,
]);

export type MemoryCueEventInput = z.infer<typeof memoryCueEventInputSchema>;
export type MemoryCueConsumptionOutcome = (typeof MEMORY_CUE_CONSUMPTION_OUTCOMES)[number];
export type MemoryCueInvalidationReason = (typeof MEMORY_CUE_INVALIDATION_REASONS)[number];

export interface MemoryCueEvent {
  eventId: string;
  idempotencyKey: string;
  cueId: string;
  opportunityId: string;
  scope: RecallScopeV1;
  resolverFamily: RecallResolverFamily;
  sourceAnchor: string;
  sourceRevision: string;
  axis: 'consumption' | 'invalidation';
  consumptionOutcome: MemoryCueConsumptionOutcome | null;
  invalidationReason: MemoryCueInvalidationReason | null;
  catalogVersion: number;
  resolverVersion: number;
  occurredAt: number;
  createdAt: string;
}

interface MemoryCueEventRow {
  event_id: string;
  idempotency_key: string;
  cue_id: string;
  opportunity_id: string;
  owner_user_id: string;
  thread_id: string;
  invocation_id: string;
  resolver_family: RecallResolverFamily;
  source_anchor: string;
  source_revision: string;
  axis: 'consumption' | 'invalidation';
  consumption_outcome: MemoryCueConsumptionOutcome | null;
  invalidation_reason: MemoryCueInvalidationReason | null;
  catalog_version: number;
  resolver_version: number;
  occurred_at: number;
  created_at: string;
}

export class MemoryCueEventConflictError extends Error {
  constructor(idempotencyKey: string) {
    super(`Memory cue idempotency conflict: ${idempotencyKey}`);
    this.name = 'MemoryCueEventConflictError';
  }
}

export class MemoryCuePresentationRequiredError extends Error {
  constructor(cueId: string) {
    super(`Memory cue must be presented before recording an outcome: ${cueId}`);
    this.name = 'MemoryCuePresentationRequiredError';
  }
}

export class MemoryCueInvalidatedError extends Error {
  constructor(cueId: string) {
    super(`Memory cue is already invalidated: ${cueId}`);
    this.name = 'MemoryCueInvalidatedError';
  }
}

function fromRow(row: MemoryCueEventRow): MemoryCueEvent {
  return {
    eventId: row.event_id,
    idempotencyKey: row.idempotency_key,
    cueId: row.cue_id,
    opportunityId: row.opportunity_id,
    scope: {
      ownerUserId: row.owner_user_id,
      threadId: row.thread_id,
      invocationId: row.invocation_id,
    },
    resolverFamily: row.resolver_family,
    sourceAnchor: row.source_anchor,
    sourceRevision: row.source_revision,
    axis: row.axis,
    consumptionOutcome: row.consumption_outcome,
    invalidationReason: row.invalidation_reason,
    catalogVersion: row.catalog_version,
    resolverVersion: row.resolver_version,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function immutableProjection(event: MemoryCueEvent) {
  const { createdAt: _createdAt, ...immutable } = event;
  return immutable;
}

function expectedEvent(input: MemoryCueEventInput, createdAt: string): MemoryCueEvent {
  return {
    eventId: input.eventId,
    idempotencyKey: input.idempotencyKey,
    cueId: input.cueId,
    opportunityId: input.opportunityId,
    scope: input.scope,
    resolverFamily: input.resolverFamily,
    sourceAnchor: input.sourceAnchor,
    sourceRevision: input.sourceRevision,
    axis: input.axis,
    consumptionOutcome: input.axis === 'consumption' ? input.consumptionOutcome : null,
    invalidationReason: input.axis === 'invalidation' ? input.invalidationReason : null,
    catalogVersion: input.catalogVersion,
    resolverVersion: input.resolverVersion,
    occurredAt: input.occurredAt,
    createdAt,
  };
}

export class MemoryCueEpisodeStore {
  private readonly nowIso: () => string;

  constructor(
    private readonly db: Database.Database,
    options: { nowIso?: () => string } = {},
  ) {
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
  }

  append(candidate: unknown): MemoryCueEvent {
    const input = memoryCueEventInputSchema.parse(candidate);
    return this.db.transaction((event: MemoryCueEventInput) => this.appendLocked(event)).immediate(input);
  }

  listByCue(ownerUserId: string, cueId: string): MemoryCueEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM memory_cue_events
           WHERE owner_user_id = ? AND cue_id = ?
           ORDER BY occurred_at ASC, rowid ASC`,
        )
        .all(ownerUserId, cueId) as MemoryCueEventRow[]
    ).map(fromRow);
  }

  findPresentedCoordinate(scope: RecallScopeV1, cueId: string, expiresAt: number): MemoryCueDrillCoordinate | null {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_cue_events
         WHERE owner_user_id = ? AND thread_id = ? AND invocation_id = ?
           AND cue_id = ? AND axis = 'consumption' AND consumption_outcome = 'presented'
         ORDER BY occurred_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(scope.ownerUserId, scope.threadId, scope.invocationId, cueId) as MemoryCueEventRow | undefined;
    if (!row) return null;
    const drillFamily = {
      person_entity: 'person_memory' as const,
      operational_precedent: 'evidence' as const,
      taste: 'taste' as const,
      profile: null,
      project_knowledge: null,
    }[row.resolver_family];
    if (!drillFamily || row.catalog_version !== RECALL_OPPORTUNITY_CATALOG_VERSION) return null;
    return {
      cueId: row.cue_id,
      opportunityId: row.opportunity_id,
      catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
      resolverFamily: row.resolver_family,
      resolverVersion: row.resolver_version,
      family: drillFamily,
      anchor: row.source_anchor,
      revision: row.source_revision,
      scope: {
        ownerUserId: row.owner_user_id,
        threadId: row.thread_id,
        invocationId: row.invocation_id,
      },
      expiresAt,
    };
  }

  private appendLocked(input: MemoryCueEventInput): MemoryCueEvent {
    const existing = this.findByIdempotencyKey(input.idempotencyKey);
    if (existing) return this.assertExactRetry(input, existing);
    if (input.axis === 'consumption' && input.consumptionOutcome !== 'presented' && !this.hasPresented(input)) {
      throw new MemoryCuePresentationRequiredError(input.cueId);
    }
    if (input.axis === 'consumption' && input.consumptionOutcome !== 'presented' && this.hasInvalidation(input)) {
      throw new MemoryCueInvalidatedError(input.cueId);
    }
    const createdAt = this.nowIso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO memory_cue_events (
          event_id, idempotency_key, cue_id, opportunity_id,
          owner_user_id, thread_id, invocation_id, resolver_family,
          source_anchor, source_revision, axis, consumption_outcome,
          invalidation_reason, catalog_version, resolver_version,
          occurred_at, created_at
        ) VALUES (
          @eventId, @idempotencyKey, @cueId, @opportunityId,
          @ownerUserId, @threadId, @invocationId, @resolverFamily,
          @sourceAnchor, @sourceRevision, @axis, @consumptionOutcome,
          @invalidationReason, @catalogVersion, @resolverVersion,
          @occurredAt, @createdAt
        )`,
      )
      .run({
        eventId: input.eventId,
        idempotencyKey: input.idempotencyKey,
        cueId: input.cueId,
        opportunityId: input.opportunityId,
        ownerUserId: input.scope.ownerUserId,
        threadId: input.scope.threadId,
        invocationId: input.scope.invocationId,
        resolverFamily: input.resolverFamily,
        sourceAnchor: input.sourceAnchor,
        sourceRevision: input.sourceRevision,
        axis: input.axis,
        consumptionOutcome: input.axis === 'consumption' ? input.consumptionOutcome : null,
        invalidationReason: input.axis === 'invalidation' ? input.invalidationReason : null,
        catalogVersion: input.catalogVersion,
        resolverVersion: input.resolverVersion,
        occurredAt: input.occurredAt,
        createdAt,
      });

    const actual = this.findByIdempotencyKey(input.idempotencyKey);
    if (!actual) throw new MemoryCueEventConflictError(input.idempotencyKey);
    return this.assertExactRetry(input, actual);
  }

  private findByIdempotencyKey(idempotencyKey: string): MemoryCueEvent | null {
    const row = this.db.prepare('SELECT * FROM memory_cue_events WHERE idempotency_key = ?').get(idempotencyKey) as
      | MemoryCueEventRow
      | undefined;
    return row ? fromRow(row) : null;
  }

  private assertExactRetry(input: MemoryCueEventInput, actual: MemoryCueEvent): MemoryCueEvent {
    const expected = expectedEvent(input, actual.createdAt);
    if (JSON.stringify(immutableProjection(actual)) !== JSON.stringify(immutableProjection(expected))) {
      throw new MemoryCueEventConflictError(input.idempotencyKey);
    }
    return actual;
  }

  private hasPresented(input: MemoryCueEventInput): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM memory_cue_events
         WHERE owner_user_id = ? AND thread_id = ? AND invocation_id = ?
           AND cue_id = ? AND axis = 'consumption' AND consumption_outcome = 'presented'
         LIMIT 1`,
      )
      .get(input.scope.ownerUserId, input.scope.threadId, input.scope.invocationId, input.cueId);
    return row !== undefined;
  }

  private hasInvalidation(input: MemoryCueEventInput): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM memory_cue_events
         WHERE owner_user_id = ? AND thread_id = ? AND invocation_id = ?
           AND cue_id = ? AND axis = 'invalidation'
         LIMIT 1`,
      )
      .get(input.scope.ownerUserId, input.scope.threadId, input.scope.invocationId, input.cueId);
    return row !== undefined;
  }
}
