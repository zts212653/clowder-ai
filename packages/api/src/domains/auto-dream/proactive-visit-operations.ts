import { proactiveEchoInputSchema } from '@cat-cafe/shared';
import {
  type ProactiveEchoRecord,
  type ProactiveIntentRecord,
  type ProactiveRecordListOptions,
  type ProactiveVisitProjectionInput,
  type ProactiveVisitRecord,
  proactiveSurfaceSchema,
} from './proactive-relationship-contract.js';
import { requireProactiveVisit } from './proactive-relationship-operations.js';
import type { AutoDreamStoreContext } from './store-context.js';
import { insertAutoDreamEvent } from './store-context.js';
import { rowToProactiveEcho, rowToProactiveIntent, rowToProactiveVisit, stringValue } from './store-rows.js';
import { AutoDreamStoreError } from './store-types.js';

type DbRow = Record<string, unknown>;

const INTENT_STATUSES = new Set(['settled_silent', 'ready', 'visit_reserved', 'projected', 'echoed', 'settled']);
const VISIT_STATUSES = new Set(['reserved', 'projected', 'echoed', 'settled', 'cancelled_unseen']);

export function listProactiveIntents(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  options: ProactiveRecordListOptions<ProactiveIntentRecord['status']> = {},
): ProactiveIntentRecord[] {
  if (options.status && !INTENT_STATUSES.has(options.status)) throw invalidProactiveRecord('invalid intent status');
  const rows = listRows(context, 'proactive_intents', ownerUserId, catId, options, 'intent_id');
  return rows.map(rowToProactiveIntent);
}

export function listProactiveVisits(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  options: ProactiveRecordListOptions<ProactiveVisitRecord['status']> = {},
): ProactiveVisitRecord[] {
  if (options.status && !VISIT_STATUSES.has(options.status)) throw invalidProactiveRecord('invalid visit status');
  const rows = listRows(context, 'proactive_visits', ownerUserId, catId, options, 'visit_id');
  return rows.map(rowToProactiveVisit);
}

export function listUnprojectedProactiveVisits(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  limit = 100,
): ProactiveVisitRecord[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw invalidProactiveRecord('unprojected visit limit must be 1..500');
  }
  const rows = context.db
    .prepare(
      `SELECT * FROM proactive_visits
       WHERE owner_user_id = ?
         AND status = 'reserved'
         AND pending_message_body IS NULL
         AND canonical_message_id IS NULL
       ORDER BY created_at, visit_id LIMIT ?`,
    )
    .all(ownerUserId, limit) as DbRow[];
  return rows.map(rowToProactiveVisit);
}

export function listProactiveEchoes(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  options: { limit?: number } = {},
): ProactiveEchoRecord[] {
  const rows = context.db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM proactive_echoes
         WHERE owner_user_id = ? AND cat_id = ?
         ORDER BY created_at DESC, echo_id DESC LIMIT ?
       ) ORDER BY created_at, echo_id`,
    )
    .all(ownerUserId, catId, boundedLimit(options.limit)) as DbRow[];
  return rows.map(rowToProactiveEcho);
}

export function markProactiveVisitProjected(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  rawInput: ProactiveVisitProjectionInput,
): ProactiveVisitRecord {
  const visitId = typeof rawInput.visitId === 'string' ? rawInput.visitId.trim() : '';
  const surface = proactiveSurfaceSchema.safeParse(rawInput.surface);
  if (!visitId || !surface.success) {
    throw invalidProactiveRecord(surface.success ? 'visitId is required' : surface.error.message);
  }

  return context.db.transaction(() => {
    const visit = requireProactiveVisit(context, ownerUserId, catId, visitId);
    if (visit.status === 'cancelled_unseen') throw proactiveVisitCancelled();
    if (visit.projectedSurfaces.some((existing) => sameSurface(existing, surface.data))) return visit;
    if (visit.status === 'settled') throw proactiveVisitAlreadyVisible();

    const now = context.now();
    const projectedSurfaces = [...visit.projectedSurfaces, surface.data];
    if (visit.status === 'reserved') consumeBudgetClaim(context, visit, now);
    context.db
      .prepare(
        `UPDATE proactive_visits
         SET status = CASE WHEN status = 'reserved' THEN 'projected' ELSE status END,
             budget_claim_state = CASE WHEN budget_claim_state = 'claimed' THEN 'consumed' ELSE budget_claim_state END,
             projected_surfaces_json = ?, updated_at = ?
         WHERE owner_user_id = ? AND cat_id = ? AND visit_id = ?`,
      )
      .run(JSON.stringify(projectedSurfaces), now, ownerUserId, catId, visitId);
    context.db
      .prepare(
        `UPDATE proactive_intents
         SET status = CASE WHEN status = 'visit_reserved' THEN 'projected' ELSE status END, updated_at = ?
         WHERE owner_user_id = ? AND intent_id = ?`,
      )
      .run(now, ownerUserId, visit.intentId);
    insertAutoDreamEvent(context, ownerUserId, catId, visit.runId, 'proactive_visit_projected', {
      intentId: visit.intentId,
      visitId,
      surfaceKind: surface.data.kind,
      outcome: 'projected',
    });
    return requireProactiveVisit(context, ownerUserId, catId, visitId);
  })();
}

export function cancelProactiveVisitUnseen(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  visitId: string,
): ProactiveVisitRecord {
  return context.db.transaction(() => {
    const visit = requireProactiveVisit(context, ownerUserId, catId, visitId);
    if (visit.status === 'cancelled_unseen') return visit;
    if (visit.status !== 'reserved' || visit.projectedSurfaces.length > 0) throw proactiveVisitAlreadyVisible();
    const now = context.now();
    const released = context.db
      .prepare(
        `UPDATE foreground_visit_budget_claims
         SET state = 'released', released_at = ?, updated_at = ?
         WHERE owner_user_id = ? AND visit_id = ? AND state = 'claimed'`,
      )
      .run(now, now, ownerUserId, visitId);
    if (released.changes !== 1) throw invalidProactiveRecord('foreground visit claim is not releasable');
    context.db
      .prepare(
        `UPDATE foreground_visit_budget_days
         SET active_claims = active_claims - 1, updated_at = ?
         WHERE owner_user_id = ? AND household_local_date = ? AND active_claims > 0`,
      )
      .run(now, ownerUserId, visit.householdLocalDate);
    context.db
      .prepare(
        `UPDATE proactive_visits
         SET status = 'cancelled_unseen', budget_claim_state = 'released', pending_message_body = NULL,
             cancelled_at = ?, updated_at = ?
         WHERE owner_user_id = ? AND cat_id = ? AND visit_id = ? AND status = 'reserved'`,
      )
      .run(now, now, ownerUserId, catId, visitId);
    context.db
      .prepare(
        `UPDATE proactive_intents SET status = 'settled', settled_at = ?, updated_at = ?
         WHERE owner_user_id = ? AND intent_id = ? AND status = 'visit_reserved'`,
      )
      .run(now, now, ownerUserId, visit.intentId);
    insertAutoDreamEvent(context, ownerUserId, catId, visit.runId, 'proactive_visit_cancelled', {
      intentId: visit.intentId,
      visitId,
      outcome: 'cancelled_unseen',
    });
    return requireProactiveVisit(context, ownerUserId, catId, visitId);
  })();
}

export function recordProactiveEcho(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  rawInput: unknown,
): ProactiveEchoRecord {
  const parsed = proactiveEchoInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidProactiveRecord(parsed.error.message);
  const input = parsed.data;

  return context.db.transaction(() => {
    const existing = context.db
      .prepare(
        `SELECT * FROM proactive_echoes
         WHERE owner_user_id = ? AND source_kind = 'typed' AND client_event_id = ?`,
      )
      .get(ownerUserId, input.clientEventId) as DbRow | undefined;
    if (existing) {
      if (
        stringValue(existing.cat_id) !== catId ||
        stringValue(existing.visit_id) !== input.visitId ||
        stringValue(existing.echo_kind) !== input.kind
      ) {
        throw new AutoDreamStoreError('PROACTIVE_ECHO_CONFLICT', 'typed echo id was reused', 409);
      }
      return rowToProactiveEcho(existing);
    }

    const visit = requireProactiveVisit(context, ownerUserId, catId, input.visitId);
    if (visit.status !== 'projected' && visit.status !== 'echoed') {
      throw new AutoDreamStoreError('PROACTIVE_VISIT_NOT_VISIBLE', 'proactive visit is not visible', 409);
    }
    const now = context.now();
    const echoId = context.idFactory('echo_');
    context.db
      .prepare(
        `INSERT INTO proactive_echoes (
           echo_id, owner_user_id, cat_id, visit_id, seed_id, echo_kind,
           source_kind, client_event_id, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'typed', ?, ?)`,
      )
      .run(echoId, ownerUserId, catId, visit.visitId, visit.seedId, input.kind, input.clientEventId, now);
    context.db
      .prepare(
        `UPDATE proactive_visits SET status = 'echoed', echoed_at = COALESCE(echoed_at, ?), updated_at = ?
         WHERE owner_user_id = ? AND cat_id = ? AND visit_id = ?`,
      )
      .run(now, now, ownerUserId, catId, visit.visitId);
    context.db
      .prepare(
        `UPDATE proactive_intents SET status = 'echoed', updated_at = ?
         WHERE owner_user_id = ? AND cat_id = ? AND intent_id = ?`,
      )
      .run(now, ownerUserId, catId, visit.intentId);
    if (input.kind === 'not_now' || input.kind === 'wrong') {
      context.db
        .prepare(
          `UPDATE owned_seeds SET status = 'dormant', dormant_at = COALESCE(dormant_at, ?), updated_at = ?
           WHERE owner_user_id = ? AND cat_id = ? AND seed_id = ? AND status = 'owned'`,
        )
        .run(now, now, ownerUserId, catId, visit.seedId);
    }
    insertAutoDreamEvent(context, ownerUserId, catId, visit.runId, 'proactive_echo_recorded', {
      intentId: visit.intentId,
      visitId: visit.visitId,
      echoId,
      echoKind: input.kind,
      outcome: input.kind === 'not_now' || input.kind === 'wrong' ? 'suppressed' : 'received',
    });
    return requireEcho(context, ownerUserId, catId, echoId);
  })();
}

function listRows<TStatus extends string>(
  context: AutoDreamStoreContext,
  table: 'proactive_intents' | 'proactive_visits',
  ownerUserId: string,
  catId: string,
  options: ProactiveRecordListOptions<TStatus>,
  idColumn: 'intent_id' | 'visit_id',
): DbRow[] {
  const limit = boundedLimit(options.limit);
  return options.status
    ? (context.db
        .prepare(
          `SELECT * FROM ${table} WHERE owner_user_id = ? AND cat_id = ? AND status = ?
           ORDER BY created_at, ${idColumn} LIMIT ?`,
        )
        .all(ownerUserId, catId, options.status, limit) as DbRow[])
    : (context.db
        .prepare(
          `SELECT * FROM ${table} WHERE owner_user_id = ? AND cat_id = ?
           ORDER BY created_at, ${idColumn} LIMIT ?`,
        )
        .all(ownerUserId, catId, limit) as DbRow[]);
}

export function consumeBudgetClaim(context: AutoDreamStoreContext, visit: ProactiveVisitRecord, now: number): void {
  const updated = context.db
    .prepare(
      `UPDATE foreground_visit_budget_claims SET state = 'consumed', updated_at = ?
       WHERE owner_user_id = ? AND visit_id = ? AND state = 'claimed'`,
    )
    .run(now, visit.ownerUserId, visit.visitId);
  if (updated.changes !== 1) throw invalidProactiveRecord('foreground visit claim is not consumable');
}

function requireEcho(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  echoId: string,
): ProactiveEchoRecord {
  const row = context.db
    .prepare('SELECT * FROM proactive_echoes WHERE owner_user_id = ? AND cat_id = ? AND echo_id = ?')
    .get(ownerUserId, catId, echoId) as DbRow | undefined;
  if (!row) throw new AutoDreamStoreError('PROACTIVE_ECHO_NOT_FOUND', 'proactive echo not found', 404);
  return rowToProactiveEcho(row);
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 20;
  if (!Number.isInteger(limit) || limit < 1) throw invalidProactiveRecord('limit must be a positive integer');
  return Math.min(limit, 50);
}

function sameSurface(left: { kind: string; refId: string }, right: { kind: string; refId: string }): boolean {
  return left.kind === right.kind && left.refId === right.refId;
}

function invalidProactiveRecord(details: string): AutoDreamStoreError {
  return new AutoDreamStoreError('INVALID_PROACTIVE_RELATIONSHIP', `invalid proactive relationship: ${details}`, 400);
}

function proactiveVisitAlreadyVisible(): AutoDreamStoreError {
  return new AutoDreamStoreError('PROACTIVE_VISIT_ALREADY_VISIBLE', 'proactive visit is already visible', 409);
}

function proactiveVisitCancelled(): AutoDreamStoreError {
  return new AutoDreamStoreError('PROACTIVE_VISIT_CANCELLED', 'proactive visit was cancelled unseen', 409);
}
