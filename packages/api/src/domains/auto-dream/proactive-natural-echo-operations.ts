import {
  type NaturalProactiveEchoInput,
  naturalProactiveEchoInputSchema,
  type ProactiveEchoRecord,
} from './proactive-relationship-contract.js';
import { requireProactiveVisit } from './proactive-relationship-operations.js';
import type { AutoDreamStoreContext } from './store-context.js';
import { insertAutoDreamEvent } from './store-context.js';
import { rowToProactiveEcho } from './store-rows.js';
import { AutoDreamStoreError } from './store-types.js';

type DbRow = Record<string, unknown>;

export function findNaturalProactiveEchoBySource(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  sourceThreadId: string,
  sourceMessageId: string,
): ProactiveEchoRecord | null {
  const row = context.db
    .prepare(
      `SELECT * FROM proactive_echoes
       WHERE owner_user_id = ? AND source_kind = 'natural_reply'
         AND source_thread_id = ? AND source_message_id = ?`,
    )
    .get(ownerUserId, sourceThreadId, sourceMessageId) as DbRow | undefined;
  return row ? rowToProactiveEcho(row) : null;
}

export function recordNaturalProactiveEcho(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  catId: string,
  rawInput: NaturalProactiveEchoInput,
): ProactiveEchoRecord {
  const parsed = naturalProactiveEchoInputSchema.safeParse(rawInput);
  if (!parsed.success) throw invalidNaturalEcho(parsed.error.message);
  const input = parsed.data;

  return context.db.transaction(() => {
    const existing = findNaturalProactiveEchoBySource(
      context,
      ownerUserId,
      input.sourceThreadId,
      input.sourceMessageId,
    );
    if (existing) {
      if (existing.catId !== catId || existing.visitId !== input.visitId) {
        throw new AutoDreamStoreError('PROACTIVE_ECHO_CONFLICT', 'natural reply was already assigned', 409);
      }
      return existing;
    }

    const visit = requireProactiveVisit(context, ownerUserId, catId, input.visitId);
    if (visit.status !== 'projected' && visit.status !== 'echoed') {
      throw new AutoDreamStoreError('PROACTIVE_VISIT_NOT_VISIBLE', 'proactive visit is not visible', 409);
    }
    if (!visit.canonicalMessageId || visit.homeThreadId !== input.sourceThreadId) {
      throw new AutoDreamStoreError('PROACTIVE_HOME_MISMATCH', 'natural echo must come from the canonical home', 409);
    }
    const now = context.now();
    const echoId = context.idFactory('echo_');
    context.db
      .prepare(
        `INSERT INTO proactive_echoes (
           echo_id, owner_user_id, cat_id, visit_id, seed_id, echo_kind,
           source_kind, source_thread_id, source_message_id, created_at
         ) VALUES (?, ?, ?, ?, ?, 'natural_reply', 'natural_reply', ?, ?, ?)`,
      )
      .run(echoId, ownerUserId, catId, visit.visitId, visit.seedId, input.sourceThreadId, input.sourceMessageId, now);
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
    insertAutoDreamEvent(context, ownerUserId, catId, visit.runId, 'proactive_echo_recorded', {
      intentId: visit.intentId,
      visitId: visit.visitId,
      echoId,
      echoKind: 'natural_reply',
      sourceMessageId: input.sourceMessageId,
      outcome: 'received',
    });
    return requireEcho(context, ownerUserId, catId, echoId);
  })();
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

function invalidNaturalEcho(details: string): AutoDreamStoreError {
  return new AutoDreamStoreError('INVALID_PROACTIVE_RELATIONSHIP', `invalid proactive relationship: ${details}`, 400);
}
