import { createHash } from 'node:crypto';
import {
  type MatterReadDetails,
  matterReadDetailsSchema,
  memoryCueDrillFamilyForResolver,
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

const LEGACY_UNBOUND_CONSUMER_CAT_ID = 'legacy-unbound';

function boundConsumerCatId(consumerCatId: string | undefined): string {
  return consumerCatId ?? LEGACY_UNBOUND_CONSUMER_CAT_ID;
}

const identifierSchema = z.string().trim().min(1).max(500);
const eventBaseShape = {
  eventId: identifierSchema,
  idempotencyKey: identifierSchema,
  cueId: identifierSchema,
  opportunityId: identifierSchema,
  scope: recallScopeV1Schema,
  consumerCatId: z.string().trim().min(1).max(120).optional(),
  resolverFamily: z.enum(RECALL_RESOLVER_FAMILIES),
  sourceAnchor: identifierSchema,
  sourceRevision: identifierSchema,
  catalogVersion: z.number().int().positive(),
  resolverVersion: z.number().int().positive(),
  occurredAt: z.number().int().nonnegative().finite(),
  readOrigin: z.enum(['push', 'explicit_read']).optional(),
  readDetails: matterReadDetailsSchema.optional(),
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

export const memoryCueEventInputSchema = z
  .discriminatedUnion('axis', [consumptionEventInputSchema, invalidationEventInputSchema])
  .superRefine((event, ctx) => {
    if (event.resolverFamily === 'matter') {
      if (
        event.readOrigin !== 'explicit_read' ||
        !event.readDetails ||
        (event.axis === 'consumption' && !['presented', 'drilled'].includes(event.consumptionOutcome))
      ) {
        ctx.addIssue({
          code: 'custom',
          message: 'Matter events require explicit read details and cannot claim application',
        });
      }
    } else if (event.readDetails || (event.readOrigin !== undefined && event.readOrigin !== 'push')) {
      ctx.addIssue({ code: 'custom', message: 'Read details belong only to the matter family' });
    }
  });

export type MemoryCueEventInput = z.infer<typeof memoryCueEventInputSchema>;
export type MemoryCueConsumptionOutcome = (typeof MEMORY_CUE_CONSUMPTION_OUTCOMES)[number];
export type MemoryCueInvalidationReason = (typeof MEMORY_CUE_INVALIDATION_REASONS)[number];

export function memoryCueConsumptionIdempotencyKey(
  cueId: string,
  outcome: Exclude<MemoryCueConsumptionOutcome, 'presented'>,
  requestId: string,
): string {
  const digest = createHash('sha256').update(['consumption', cueId, outcome, requestId].join('\0')).digest('hex');
  return `memory-cue-consumption-${digest.slice(0, 40)}`;
}

export interface MemoryCueEvent {
  eventId: string;
  idempotencyKey: string;
  cueId: string;
  opportunityId: string;
  scope: RecallScopeV1;
  consumerCatId: string;
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
  readOrigin?: 'explicit_read';
  readDetails?: MatterReadDetails;
}

interface MemoryCueEventRow {
  event_id: string;
  idempotency_key: string;
  cue_id: string;
  opportunity_id: string;
  owner_user_id: string;
  thread_id: string;
  invocation_id: string;
  consumer_cat_id: string;
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
  read_origin: 'push' | 'explicit_read';
  read_details_json: string | null;
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
  const readDetails =
    row.read_details_json === null ? undefined : matterReadDetailsSchema.parse(JSON.parse(row.read_details_json));
  if (
    (row.resolver_family === 'matter') !== Boolean(readDetails) ||
    (row.resolver_family === 'matter' ? row.read_origin !== 'explicit_read' : row.read_origin !== 'push')
  ) {
    throw new Error('Invalid memory cue read origin');
  }
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
    consumerCatId: row.consumer_cat_id,
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
    ...(row.read_origin === 'explicit_read' ? { readOrigin: 'explicit_read' as const } : {}),
    ...(readDetails ? { readDetails } : {}),
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
    consumerCatId: boundConsumerCatId(input.consumerCatId),
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
    ...(input.readOrigin === 'explicit_read' ? { readOrigin: 'explicit_read' as const } : {}),
    ...(input.readDetails ? { readDetails: input.readDetails } : {}),
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

  /** A successful tool read is one atomic fact, with two immutable outcome events. */
  appendMatterRead(input: {
    scope: RecallScopeV1;
    consumerCatId: string;
    details: MatterReadDetails;
  }): MemoryCueEvent[] {
    const details = matterReadDetailsSchema.parse({
      ...input.details,
      entries: [...new Map(input.details.entries.map((entry) => [JSON.stringify(entry), entry])).values()].sort(
        (a, b) => a.entryId.localeCompare(b.entryId) || a.sourceRevision.localeCompare(b.sourceRevision),
      ),
    });
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const cueId = `matter-read-${hash([input.scope, input.consumerCatId, details.matterId, details.pageRevision])}`;
    const readKey = hash([cueId, details.entries]);
    return this.db
      .transaction(() =>
        (['presented', 'drilled'] as const).map((outcome) =>
          this.appendLocked(
            memoryCueEventInputSchema.parse({
              eventId: `${readKey}-${outcome}`,
              idempotencyKey: `matter-${readKey}-${outcome}`,
              cueId,
              opportunityId: `explicit-${cueId}`,
              scope: input.scope,
              consumerCatId: input.consumerCatId,
              resolverFamily: 'matter',
              sourceAnchor: `matter:${details.matterId}`,
              sourceRevision: `revision:${details.pageRevision}`,
              axis: 'consumption',
              consumptionOutcome: outcome,
              catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
              resolverVersion: 1,
              occurredAt: Date.now(),
              readOrigin: 'explicit_read',
              readDetails: details,
            }),
          ),
        ),
      )
      .immediate();
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

  listByInvocation(ownerUserId: string, threadId: string, invocationId: string): MemoryCueEvent[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM memory_cue_events
           WHERE owner_user_id = ? AND thread_id = ? AND invocation_id = ?
           ORDER BY occurred_at ASC, rowid ASC`,
        )
        .all(ownerUserId, threadId, invocationId) as MemoryCueEventRow[]
    ).map(fromRow);
  }

  getByEventId(eventId: string): MemoryCueEvent | null {
    const row = this.db.prepare('SELECT * FROM memory_cue_events WHERE event_id = ?').get(eventId) as
      | MemoryCueEventRow
      | undefined;
    return row ? fromRow(row) : null;
  }

  hasConsumptionOutcome(
    scope: RecallScopeV1,
    cueId: string,
    outcome: MemoryCueConsumptionOutcome,
    consumerCatId?: string,
  ): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM memory_cue_events
         WHERE owner_user_id = ? AND thread_id = ? AND invocation_id = ?
           AND consumer_cat_id = ? AND cue_id = ? AND axis = 'consumption' AND consumption_outcome = ?
         LIMIT 1`,
      )
      .get(scope.ownerUserId, scope.threadId, scope.invocationId, boundConsumerCatId(consumerCatId), cueId, outcome);
    return row !== undefined;
  }

  hasExactConsumptionRequest(input: {
    scope: RecallScopeV1;
    cueId: string;
    outcome: MemoryCueConsumptionOutcome;
    idempotencyKey: string;
    consumerCatId?: string;
  }): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM memory_cue_events
         WHERE owner_user_id = ? AND thread_id = ? AND invocation_id = ?
           AND consumer_cat_id = ? AND cue_id = ?
           AND axis = 'consumption' AND consumption_outcome = ? AND idempotency_key = ?
         LIMIT 1`,
      )
      .get(
        input.scope.ownerUserId,
        input.scope.threadId,
        input.scope.invocationId,
        boundConsumerCatId(input.consumerCatId),
        input.cueId,
        input.outcome,
        input.idempotencyKey,
      );
    return row !== undefined;
  }

  hasTerminalConsumptionForSource(input: {
    ownerUserId: string;
    resolverFamily: RecallResolverFamily;
    sourceAnchor: string;
    sourceRevision: string;
  }): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM memory_cue_events
         WHERE owner_user_id = ? AND resolver_family = ?
           AND source_anchor = ? AND source_revision = ?
           AND axis = 'consumption' AND consumption_outcome IN ('applied', 'dismissed')
         LIMIT 1`,
      )
      .get(input.ownerUserId, input.resolverFamily, input.sourceAnchor, input.sourceRevision);
    return row !== undefined;
  }

  findPresentedCoordinate(
    scope: RecallScopeV1,
    cueId: string,
    expiresAt: number,
    consumerCatId?: string,
  ): MemoryCueDrillCoordinate | null {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_cue_events
         WHERE owner_user_id = ? AND thread_id = ? AND invocation_id = ?
           AND consumer_cat_id = ? AND cue_id = ?
           AND axis = 'consumption' AND consumption_outcome = 'presented'
         ORDER BY occurred_at DESC, rowid DESC
         LIMIT 1`,
      )
      .get(scope.ownerUserId, scope.threadId, scope.invocationId, boundConsumerCatId(consumerCatId), cueId) as
      | MemoryCueEventRow
      | undefined;
    if (!row) return null;
    const drillFamily = memoryCueDrillFamilyForResolver(row.resolver_family);
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
      ...(row.consumer_cat_id === LEGACY_UNBOUND_CONSUMER_CAT_ID ? {} : { consumerCatId: row.consumer_cat_id }),
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
          owner_user_id, thread_id, invocation_id, consumer_cat_id, resolver_family,
          source_anchor, source_revision, axis, consumption_outcome,
          invalidation_reason, catalog_version, resolver_version,
          occurred_at, created_at, read_origin, read_details_json
        ) VALUES (
          @eventId, @idempotencyKey, @cueId, @opportunityId,
          @ownerUserId, @threadId, @invocationId, @consumerCatId, @resolverFamily,
          @sourceAnchor, @sourceRevision, @axis, @consumptionOutcome,
          @invalidationReason, @catalogVersion, @resolverVersion,
          @occurredAt, @createdAt, @readOrigin, @readDetailsJson
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
        consumerCatId: boundConsumerCatId(input.consumerCatId),
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
        readOrigin: input.readOrigin ?? 'push',
        readDetailsJson: input.readDetails ? JSON.stringify(input.readDetails) : null,
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
    // Idempotent retries can arrive later than the first committed write. The
    // original event owns occurrence time; compare every caller-controlled
    // coordinate/outcome field while reusing that committed timestamp.
    const expected = expectedEvent({ ...input, occurredAt: actual.occurredAt }, actual.createdAt);
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
           AND consumer_cat_id = ? AND cue_id = ?
           AND axis = 'consumption' AND consumption_outcome = 'presented'
         LIMIT 1`,
      )
      .get(
        input.scope.ownerUserId,
        input.scope.threadId,
        input.scope.invocationId,
        boundConsumerCatId(input.consumerCatId),
        input.cueId,
      );
    return row !== undefined;
  }

  private hasInvalidation(input: MemoryCueEventInput): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM memory_cue_events
         WHERE owner_user_id = ? AND thread_id = ? AND invocation_id = ?
           AND consumer_cat_id = ? AND cue_id = ? AND axis = 'invalidation'
         LIMIT 1`,
      )
      .get(
        input.scope.ownerUserId,
        input.scope.threadId,
        input.scope.invocationId,
        boundConsumerCatId(input.consumerCatId),
        input.cueId,
      );
    return row !== undefined;
  }
}
