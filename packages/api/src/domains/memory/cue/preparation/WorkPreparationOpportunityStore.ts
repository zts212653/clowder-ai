import { matterReadDetailsSchema, type RecallScopeV1 } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { type MemoryCueDrillCoordinate, memoryCueDrillCoordinateSchema } from '../MemoryCueDrillHandleService.js';

export const preparationCoordinateSchema = z
  .object({
    coordinate: memoryCueDrillCoordinateSchema,
    matterReadDetails: matterReadDetailsSchema.optional(),
  })
  .strict();
export type PreparedCoordinate = z.infer<typeof preparationCoordinateSchema>;
export interface WorkPreparationRecord {
  opportunityId: string;
  scope: RecallScopeV1;
  consumerCatId: string;
  contextEpoch: number;
  sourceMessageId: string;
  projectPath: string;
  activity: 'html' | 'video';
  queryDigest: string;
  occurredAt: number;
  expiresAt: number;
}
interface Row {
  opportunity_id: string;
  owner_user_id: string;
  thread_id: string;
  invocation_id: string;
  consumer_cat_id: string;
  context_epoch: number;
  source_message_id: string;
  project_path: string;
  activity: 'html' | 'video';
  query_digest: string;
  occurred_at: number;
  expires_at: number;
  coordinates_json: string;
}

/** Host-observed preparation events and opaque source coordinates, never delivery receipts or source bodies. */
export class WorkPreparationOpportunityStore {
  constructor(private readonly db: Database.Database) {}

  receive(record: WorkPreparationRecord): WorkPreparationRecord {
    this.db
      .prepare(`INSERT OR IGNORE INTO memory_cue_preparation_opportunities
      (opportunity_id,owner_user_id,thread_id,invocation_id,consumer_cat_id,context_epoch,source_message_id,project_path,activity,query_digest,occurred_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        record.opportunityId,
        record.scope.ownerUserId,
        record.scope.threadId,
        record.scope.invocationId,
        record.consumerCatId,
        record.contextEpoch,
        record.sourceMessageId,
        record.projectPath,
        record.activity,
        record.queryDigest,
        record.occurredAt,
        record.expiresAt,
      );
    const stored = this.get(record.opportunityId);
    if (!stored) throw new Error('Preparation event was not persisted');
    return stored;
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM memory_cue_preparation_opportunities WHERE opportunity_id=?').get(id) as
      | Row
      | undefined;
  }

  get(id: string): WorkPreparationRecord | null {
    const r = this.row(id);
    return r
      ? {
          opportunityId: r.opportunity_id,
          scope: { ownerUserId: r.owner_user_id, threadId: r.thread_id, invocationId: r.invocation_id },
          consumerCatId: r.consumer_cat_id,
          contextEpoch: r.context_epoch,
          sourceMessageId: r.source_message_id,
          projectPath: r.project_path,
          activity: r.activity,
          queryDigest: r.query_digest,
          occurredAt: r.occurred_at,
          expiresAt: r.expires_at,
        }
      : null;
  }

  save(id: string, candidate: PreparedCoordinate): void {
    const parsed = preparationCoordinateSchema.parse(candidate);
    const record = this.get(id);
    if (
      !record ||
      parsed.coordinate.scope.ownerUserId !== record.scope.ownerUserId ||
      parsed.coordinate.scope.threadId !== record.scope.threadId ||
      parsed.coordinate.scope.invocationId !== record.scope.invocationId ||
      parsed.coordinate.consumerCatId !== record.consumerCatId ||
      parsed.coordinate.opportunityId !== id
    )
      throw new Error('Preparation coordinate binding mismatch');
    this.db
      .transaction(() => {
        const row = this.row(id);
        if (!row) throw new Error('Preparation event is missing');
        const previous = z.array(preparationCoordinateSchema).parse(JSON.parse(row.coordinates_json));
        const existing = previous.find((entry) => entry.coordinate.cueId === parsed.coordinate.cueId);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(parsed)) throw new Error('Preparation coordinate conflict');
          return;
        }
        this.db
          .prepare('UPDATE memory_cue_preparation_opportunities SET coordinates_json=? WHERE opportunity_id=?')
          .run(JSON.stringify([...previous, parsed]), id);
      })
      .immediate();
  }

  recordSources(id: string, sourceIds: readonly string[]): void {
    this.db
      .prepare('UPDATE memory_cue_preparation_opportunities SET source_ids_json=? WHERE opportunity_id=?')
      .run(JSON.stringify(sourceIds), id);
  }

  finish(
    id: string,
    status: string,
    discovery?: {
      version: string;
      sources: readonly { sourceId: string; inspected: number; stopReason: string }[];
    },
  ): void {
    this.db
      .prepare(`UPDATE memory_cue_preparation_opportunities SET result_status=?,
      discovery_version=?,discovery_sources_json=? WHERE opportunity_id=?`)
      .run(
        status,
        discovery?.version ?? null,
        JSON.stringify(
          discovery?.sources.map(({ sourceId, inspected, stopReason }) => ({ sourceId, inspected, stopReason })) ?? [],
        ),
        id,
      );
  }

  findPreparedCoordinate(
    scope: RecallScopeV1,
    cueId: string,
    expiresAt: number,
    catId?: string,
  ): MemoryCueDrillCoordinate | null {
    const rows = this.db
      .prepare(`SELECT coordinates_json FROM memory_cue_preparation_opportunities
      WHERE owner_user_id=? AND thread_id=? AND invocation_id=? AND consumer_cat_id=? AND expires_at=?`)
      .all(scope.ownerUserId, scope.threadId, scope.invocationId, catId ?? '', expiresAt) as {
      coordinates_json: string;
    }[];
    for (const row of rows) {
      const found = z
        .array(preparationCoordinateSchema)
        .parse(JSON.parse(row.coordinates_json))
        .find((entry) => entry.coordinate.cueId === cueId);
      if (found) return found.coordinate;
    }
    return null;
  }

  details(opportunityId: string, anchor: string, revision: string): PreparedCoordinate | null {
    const row = this.row(opportunityId);
    return row
      ? (z
          .array(preparationCoordinateSchema)
          .parse(JSON.parse(row.coordinates_json))
          .find((entry) => entry.coordinate.anchor === anchor && entry.coordinate.revision === revision) ?? null)
      : null;
  }

  wasConsumed(
    record: WorkPreparationRecord,
    coordinate: Pick<
      MemoryCueDrillCoordinate,
      'resolverFamily' | 'anchor' | 'revision' | 'catalogVersion' | 'resolverVersion'
    >,
  ): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM memory_cue_events e
      LEFT JOIN memory_cue_preparation_opportunities p ON p.opportunity_id=e.opportunity_id
      LEFT JOIN memory_cue_context_opportunities c ON c.opportunity_id=e.opportunity_id
      WHERE e.owner_user_id=? AND e.thread_id=? AND e.consumer_cat_id=?
        AND e.resolver_family=? AND e.source_anchor=? AND e.source_revision=?
        AND e.catalog_version=? AND e.resolver_version=?
        AND e.axis='consumption' AND e.consumption_outcome IN ('presented','drilled')
        AND ((p.context_epoch=? AND p.activity=? AND p.query_digest=?) OR c.context_epoch=?) LIMIT 1`)
      .get(
        record.scope.ownerUserId,
        record.scope.threadId,
        record.consumerCatId,
        coordinate.resolverFamily,
        coordinate.anchor,
        coordinate.revision,
        coordinate.catalogVersion,
        coordinate.resolverVersion,
        record.contextEpoch,
        record.activity,
        record.queryDigest,
        record.contextEpoch,
      );
  }
}
