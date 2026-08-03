import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EvidenceDrillDown } from './interfaces.js';
import type {
  ExtractedReflectionDelta,
  ReflectionBatchInput,
  ReflectionBatchResult,
  ReflectionCueDeliveryRecord,
  ReflectionOutputRecord,
  ReflectionSourceRef,
} from './reflection-types.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';

const PRODUCER = 'f271-session-close-v1' as const;
const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface ReflectionRow {
  output_id: string;
  owner_user_id: string;
  household_local_date: string;
  cat_id: string;
  source_ref_json: string;
  output_kind: ReflectionOutputRecord['kind'];
  normalized_claim: string | null;
  reason: string | null;
  claim_fingerprint: string;
  destination: ReflectionOutputRecord['destination'];
  projection_state: ReflectionOutputRecord['projectionState'];
  projection_ref: string | null;
  producer: typeof PRODUCER;
  created_at: string;
  delivered_at: string | null;
}

export class MemoryReflectionStore {
  constructor(private readonly evidenceStore: SqliteEvidenceStore) {}

  async acceptBatch(input: ReflectionBatchInput): Promise<ReflectionBatchResult> {
    validateBatch(input);
    return this.evidenceStore.runExclusive(() => {
      const db = this.evidenceStore.getDb();
      return db.transaction(() => this.acceptBatchInTransaction(db, input))();
    });
  }

  async countAccepted(ownerUserId: string, householdLocalDate: string): Promise<number> {
    return this.evidenceStore.runExclusive(() => {
      const row = this.evidenceStore
        .getDb()
        .prepare(
          `SELECT COUNT(*) AS count FROM reflection_outputs
           WHERE owner_user_id = ? AND household_local_date = ?`,
        )
        .get(ownerUserId, householdLocalDate) as { count: number };
      return row.count;
    });
  }

  async listPendingCues(ownerUserId: string, catId: string, limit = 50): Promise<ReflectionOutputRecord[]> {
    if (!ownerUserId.trim() || !catId.trim()) throw new Error('pending cue ownerUserId and catId are required');
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('pending cue limit must be 1..500');
    return this.evidenceStore.runExclusive(() => {
      const rows = this.evidenceStore
        .getDb()
        .prepare(
          `SELECT * FROM reflection_outputs
           WHERE owner_user_id = ? AND cat_id = ?
             AND destination = 'f255_private_cue' AND projection_state = 'pending'
           ORDER BY created_at, output_id LIMIT ?`,
        )
        .all(ownerUserId, catId, limit) as ReflectionRow[];
      return rows.map(rowToRecord);
    });
  }

  async markCueDelivered(
    outputId: string,
    ownerUserId: string,
    catId: string,
    projectionRef: string,
    deliveredAt: string,
  ): Promise<ReflectionCueDeliveryRecord> {
    if (!outputId.trim() || !ownerUserId.trim() || !catId.trim() || !projectionRef.trim() || !isIsoDate(deliveredAt)) {
      throw new Error('valid outputId, ownerUserId, catId, projectionRef, and deliveredAt are required');
    }
    return this.evidenceStore.runExclusive(() => {
      const db = this.evidenceStore.getDb();
      return db.transaction(() => {
        const existing = findPrivateCueByScope(db, outputId, ownerUserId, catId);
        if (!existing) throw new Error('pending private cue not found in owner/cat scope');
        if (existing.projection_state === 'delivered') {
          if (existing.projection_ref !== projectionRef)
            throw new Error('private cue already delivered to another ref');
          return rowToCueDeliveryRecord(existing);
        }
        db.prepare(
          `UPDATE reflection_outputs
           SET projection_state = 'delivered', projection_ref = ?, delivered_at = ?,
               normalized_claim = NULL, reason = NULL
           WHERE output_id = ? AND owner_user_id = ? AND cat_id = ?
             AND destination = 'f255_private_cue' AND projection_state = 'pending'`,
        ).run(projectionRef, deliveredAt, outputId, ownerUserId, catId);
        const updated = findPrivateCueByScope(db, outputId, ownerUserId, catId);
        if (!updated) throw new Error('private cue delivery acknowledgement disappeared');
        return rowToCueDeliveryRecord(updated);
      })();
    });
  }

  private acceptBatchInTransaction(db: Database.Database, input: ReflectionBatchInput): ReflectionBatchResult {
    const result: ReflectionBatchResult = { accepted: [], duplicates: [], rejected: [] };
    let used = countForDay(db, input.ownerUserId, input.householdLocalDate);

    for (const output of input.outputs) {
      validateDelta(output, input.catId);
      const outputId = buildReflectionOutputId(input, output);
      const duplicate = findDuplicate(db, input, outputId, output);
      if (duplicate) {
        reconcileDuplicateSource(db, input, output, duplicate);
        result.duplicates.push({ outputId, existingOutputId: duplicate.output_id });
        continue;
      }
      if (used >= input.budget) {
        result.rejected.push({ outputId, reason: 'budget_exhausted' });
        continue;
      }

      const projectionRef = output.destination === 'public_evidence' ? `reflection-candidate:${outputId}` : undefined;
      insertLedgerRow(db, input, output, outputId, projectionRef);
      if (projectionRef) insertPublicProjection(db, input, output, projectionRef);
      const accepted = findRowByOutputId(db, outputId);
      if (!accepted) throw new Error('accepted reflection output disappeared');
      result.accepted.push(rowToRecord(accepted));
      used += 1;
    }
    return result;
  }
}

export function buildReflectionOutputId(
  input: Pick<ReflectionBatchInput, 'ownerUserId' | 'catId'>,
  output: ExtractedReflectionDelta,
): string {
  const payload = [
    input.ownerUserId,
    input.catId,
    output.destination,
    output.kind,
    output.normalizedClaim,
    buildReflectionSourceKey(output.sourceRef),
  ].join('\0');
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function insertLedgerRow(
  db: Database.Database,
  input: ReflectionBatchInput,
  output: ExtractedReflectionDelta,
  outputId: string,
  projectionRef: string | undefined,
): void {
  db.prepare(
    `INSERT INTO reflection_outputs
      (output_id, owner_user_id, household_local_date, cat_id, source_ref_json,
       output_kind, normalized_claim, reason, claim_fingerprint, destination,
       projection_state, projection_ref, producer, created_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    outputId,
    input.ownerUserId,
    input.householdLocalDate,
    input.catId,
    JSON.stringify(output.sourceRef),
    output.kind,
    output.normalizedClaim,
    output.reason,
    buildReflectionClaimFingerprint(input, output),
    output.destination,
    projectionRef ? 'delivered' : 'pending',
    projectionRef ?? null,
    PRODUCER,
    input.createdAt,
    projectionRef ? input.createdAt : null,
  );
}

function insertPublicProjection(
  db: Database.Database,
  input: ReflectionBatchInput,
  output: ExtractedReflectionDelta,
  anchor: string,
): void {
  db.prepare(
    `INSERT INTO evidence_docs
      (anchor, kind, status, title, summary, keywords, materialized_from, updated_at,
       provenance_tier, provenance_source, authority, activation, first_indexed_at, drill_down_json)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?, 'soft_clue', ?, 'candidate', 'pull_only', ?, ?)`,
  ).run(
    anchor,
    output.kind === 'decision' ? 'decision' : 'discussion',
    `Reflection candidate · ${output.kind} · ${output.normalizedClaim.slice(0, 80)}`,
    output.normalizedClaim,
    JSON.stringify(['reflection', 'candidate', output.kind, input.catId]),
    buildReflectionSourceKey(output.sourceRef),
    input.createdAt,
    PRODUCER,
    Date.parse(input.createdAt),
    JSON.stringify(sourceDrillDown(output.sourceRef)),
  );
}

function updateDuplicateSource(
  db: Database.Database,
  duplicate: ReflectionRow,
  sourceRef: ReflectionSourceRef,
  updatedAt: string,
): void {
  db.prepare('UPDATE reflection_outputs SET source_ref_json = ? WHERE output_id = ?').run(
    JSON.stringify(sourceRef),
    duplicate.output_id,
  );
  if (duplicate.destination !== 'public_evidence') return;
  if (!duplicate.projection_ref) throw new Error('public reflection duplicate is missing its projection ref');
  const result = db
    .prepare(
      `UPDATE evidence_docs
       SET materialized_from = ?, updated_at = ?, drill_down_json = ?
       WHERE anchor = ?`,
    )
    .run(
      buildReflectionSourceKey(sourceRef),
      updatedAt,
      JSON.stringify(sourceDrillDown(sourceRef)),
      duplicate.projection_ref,
    );
  if (result.changes !== 1) throw new Error('public reflection duplicate projection disappeared');
}

function sourceDrillDown(source: ReflectionSourceRef): EvidenceDrillDown {
  if (source.messageId) {
    return {
      tool: 'cat_cafe_get_thread_context',
      params: { threadId: source.threadId, messageId: source.messageId, before: '3', after: '3' },
      hint: 'Open the original thread message that produced this reflection candidate.',
    };
  }
  if (source.sessionId != null && source.eventNo != null) {
    return {
      tool: 'cat_cafe_read_session_events',
      params: { sessionId: source.sessionId, cursor: String(source.eventNo), limit: '1', view: 'chat' },
      hint: 'Open the exact sealed transcript event that produced this reflection candidate.',
    };
  }
  throw new Error('reflection source is not drillable');
}

function findDuplicate(
  db: Database.Database,
  input: ReflectionBatchInput,
  outputId: string,
  output: ExtractedReflectionDelta,
): ReflectionRow | undefined {
  const claimFingerprint = buildReflectionClaimFingerprint(input, output);
  return db
    .prepare(
      `SELECT * FROM reflection_outputs WHERE output_id = ? OR
       (owner_user_id = ? AND cat_id = ? AND destination = ? AND output_kind = ? AND claim_fingerprint = ?)
       ORDER BY created_at LIMIT 1`,
    )
    .get(outputId, input.ownerUserId, input.catId, output.destination, output.kind, claimFingerprint) as
    | ReflectionRow
    | undefined;
}

function parseSourceRef(row: ReflectionRow): ReflectionSourceRef {
  return JSON.parse(row.source_ref_json) as ReflectionSourceRef;
}

export function isEarlierReflectionSource(candidate: ReflectionSourceRef, existing: ReflectionSourceRef): boolean {
  if (Number.isFinite(candidate.eventAt) && Number.isFinite(existing.eventAt)) {
    if (candidate.eventAt !== existing.eventAt) return (candidate.eventAt as number) < (existing.eventAt as number);
  } else if (candidate.sessionId === existing.sessionId && candidate.eventNo != null && existing.eventNo != null) {
    if (candidate.eventNo !== existing.eventNo) return candidate.eventNo < existing.eventNo;
  } else {
    return false;
  }
  return buildReflectionSourceKey(candidate).localeCompare(buildReflectionSourceKey(existing)) < 0;
}

function backfillSourceEventAt(
  sourceRef: ReflectionSourceRef,
  sourceEventTimes: Record<string, number> | undefined,
): ReflectionSourceRef {
  if (Number.isFinite(sourceRef.eventAt)) return sourceRef;
  const eventAt = sourceEventTimes?.[buildReflectionSourceKey(sourceRef)];
  return Number.isFinite(eventAt) ? { ...sourceRef, eventAt } : sourceRef;
}

function updateDuplicateLedgerSource(
  db: Database.Database,
  duplicate: ReflectionRow,
  sourceRef: ReflectionSourceRef,
): void {
  db.prepare('UPDATE reflection_outputs SET source_ref_json = ? WHERE output_id = ?').run(
    JSON.stringify(sourceRef),
    duplicate.output_id,
  );
}

function reconcileDuplicateSource(
  db: Database.Database,
  input: ReflectionBatchInput,
  output: ExtractedReflectionDelta,
  duplicate: ReflectionRow,
): void {
  const existingSource = parseSourceRef(duplicate);
  const comparableExisting = backfillSourceEventAt(existingSource, input.sourceEventTimes);
  if (isEarlierReflectionSource(output.sourceRef, comparableExisting)) {
    updateDuplicateSource(db, duplicate, output.sourceRef, input.createdAt);
    return;
  }
  if (comparableExisting !== existingSource) {
    updateDuplicateLedgerSource(db, duplicate, comparableExisting);
  }
}

function buildReflectionClaimFingerprint(
  input: Pick<ReflectionBatchInput, 'ownerUserId' | 'catId'>,
  output: Pick<ExtractedReflectionDelta, 'destination' | 'kind' | 'normalizedClaim'>,
): string {
  return createHash('sha256')
    .update([input.ownerUserId, input.catId, output.destination, output.kind, output.normalizedClaim].join('\0'))
    .digest('hex');
}

function findRowByOutputId(db: Database.Database, outputId: string): ReflectionRow | undefined {
  return db.prepare('SELECT * FROM reflection_outputs WHERE output_id = ?').get(outputId) as ReflectionRow | undefined;
}

function findPrivateCueByScope(
  db: Database.Database,
  outputId: string,
  ownerUserId: string,
  catId: string,
): ReflectionRow | undefined {
  return db
    .prepare(
      `SELECT * FROM reflection_outputs
       WHERE output_id = ? AND owner_user_id = ? AND cat_id = ? AND destination = 'f255_private_cue'`,
    )
    .get(outputId, ownerUserId, catId) as ReflectionRow | undefined;
}

function countForDay(db: Database.Database, ownerUserId: string, localDate: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM reflection_outputs WHERE owner_user_id = ? AND household_local_date = ?')
    .get(ownerUserId, localDate) as { count: number };
  return row.count;
}

function rowToRecord(row: ReflectionRow): ReflectionOutputRecord {
  if (row.normalized_claim == null || row.reason == null) {
    throw new Error('delivered private cue body is no longer available from F271');
  }
  return {
    outputId: row.output_id,
    ownerUserId: row.owner_user_id,
    householdLocalDate: row.household_local_date,
    catId: row.cat_id,
    sourceRef: JSON.parse(row.source_ref_json) as ReflectionSourceRef,
    kind: row.output_kind,
    normalizedClaim: row.normalized_claim,
    reason: row.reason,
    destination: row.destination,
    projectionState: row.projection_state,
    ...(row.projection_ref ? { projectionRef: row.projection_ref } : {}),
    producer: row.producer,
    createdAt: row.created_at,
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
  };
}

function rowToCueDeliveryRecord(row: ReflectionRow): ReflectionCueDeliveryRecord {
  if (row.projection_state !== 'delivered' || !row.projection_ref || !row.delivered_at) {
    throw new Error('private cue delivery metadata is incomplete');
  }
  return {
    outputId: row.output_id,
    ownerUserId: row.owner_user_id,
    catId: row.cat_id,
    projectionState: 'delivered',
    projectionRef: row.projection_ref,
    producer: row.producer,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

function validateBatch(input: ReflectionBatchInput): void {
  if (!input.ownerUserId.trim() || !input.catId.trim()) throw new Error('ownerUserId and catId are required');
  if (!LOCAL_DATE_PATTERN.test(input.householdLocalDate)) throw new Error('householdLocalDate must be YYYY-MM-DD');
  if (!isIsoDate(input.createdAt)) throw new Error('createdAt must be an ISO timestamp');
  if (!Number.isInteger(input.budget) || input.budget < 0) throw new Error('budget must be a non-negative integer');
  if (input.sourceEventTimes && Object.values(input.sourceEventTimes).some((eventAt) => !Number.isFinite(eventAt))) {
    throw new Error('sourceEventTimes must contain finite event timestamps');
  }
}

function validateDelta(output: ExtractedReflectionDelta, catId: string): void {
  if (!output.normalizedClaim.trim() || !output.reason.trim()) throw new Error('claim and reason are required');
  if (output.destination === 'f255_private_cue' && output.targetCatId !== catId) {
    throw new Error('private cue target must match the sealing cat');
  }
  sourceDrillDown(output.sourceRef);
}

export function buildReflectionSourceKey(source: ReflectionSourceRef): string {
  return JSON.stringify({
    threadId: source.threadId,
    ...(source.messageId ? { messageId: source.messageId } : {}),
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    ...(source.eventNo != null ? { eventNo: source.eventNo } : {}),
    ...(source.invocationId ? { invocationId: source.invocationId } : {}),
  });
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && value.includes('T');
}
