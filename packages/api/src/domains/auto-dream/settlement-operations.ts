import type Database from 'better-sqlite3';
import { consumeContinuityLease, replacePendingPosture } from './continuity-operations.js';
import { expireAwakenedRuns } from './lease-operations.js';
import { loadProactiveSettlementState, settleProactiveRelationship } from './proactive-relationship-operations.js';
import type { SettlementIds } from './store-config.js';
import { type AutoDreamStoreContext, insertAutoDreamEvent } from './store-context.js';
import { type DbRow, hashValue, rowToRun, runNotFound, stringOrUndefined, validateSettlement } from './store-rows.js';
import {
  AutoDreamStoreError,
  type DreamEvidenceRefValue,
  type InvocationPrincipal,
  type SettlePresentLoopValue,
} from './store-types.js';

export function settleRun(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  input: SettlePresentLoopValue,
): SettlementIds {
  validateSettlement(input);
  expireAwakenedRuns(context, { ownerUserId: principal.userId, runId: input.runId });
  const settlementHash = hashValue(input);

  return context.db.transaction(() => {
    const idempotent = inspectRunForSettlement(context, principal, input.runId, settlementHash);
    if (idempotent) return idempotent;

    const proactive = settleProactiveRelationship(context, principal, input);
    const now = context.now();
    consumeContinuityLease(context, principal.userId, input.runId, now);
    const diaryId = input.diary ? insertDiary(context, principal, input.runId, input.diary, now) : undefined;
    const postureId =
      input.sleepPosture === undefined
        ? undefined
        : replacePendingPosture(context, principal, input.runId, input.sleepPosture, now);

    const updated = context.db
      .prepare(
        `UPDATE present_loop_runs
         SET state = 'settled', outcome = ?, settlement_invocation_id = ?, settlement_hash = ?,
             diary_id = ?, sleep_posture_id = ?, settled_at = ?, updated_at = ?
         WHERE owner_user_id = ? AND run_id = ? AND state = 'awakened'`,
      )
      .run(
        input.outcome,
        principal.invocationId,
        settlementHash,
        diaryId ?? null,
        postureId ?? null,
        now,
        now,
        principal.userId,
        input.runId,
      );
    if (updated.changes !== 1) {
      throw new AutoDreamStoreError('RUN_ALREADY_SETTLED', 'present loop run settled concurrently', 409);
    }
    insertAutoDreamEvent(context, principal.userId, principal.catId, input.runId, 'run_settled', {
      outcome: input.outcome,
      diaryId,
      postureId,
      traceKind: input.diary?.traceKind,
    });
    return { runId: input.runId, diaryId, postureId, ...proactive };
  })();
}

function inspectRunForSettlement(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  runId: string,
  settlementHash: string,
): SettlementIds | null {
  const raw = context.db
    .prepare('SELECT * FROM present_loop_runs WHERE owner_user_id = ? AND run_id = ?')
    .get(principal.userId, runId) as DbRow | undefined;
  if (!raw || raw.cat_id !== principal.catId || raw.thread_id !== principal.threadId) throw runNotFound();
  const run = rowToRun(raw);
  if (run.state === 'awakened') return null;
  if (run.state !== 'settled') {
    throw new AutoDreamStoreError('RUN_NOT_SETTLEABLE', 'present loop run is not settleable', 409);
  }
  if (raw.settlement_invocation_id !== principal.invocationId || raw.settlement_hash !== settlementHash) {
    throw new AutoDreamStoreError('RUN_ALREADY_SETTLED', 'present loop run already settled', 409);
  }
  const proactive = loadProactiveSettlementState(context, principal.userId, runId);
  return {
    runId: run.runId,
    diaryId: stringOrUndefined(raw.diary_id),
    postureId: stringOrUndefined(raw.sleep_posture_id),
    seedId: proactive.seed?.seedId,
    intentId: proactive.intent?.intentId,
    visitId: proactive.visit?.visitId,
    visibilityBlock: proactive.visibilityBlock ?? undefined,
  };
}

function insertDiary(
  context: AutoDreamStoreContext,
  principal: InvocationPrincipal,
  runId: string,
  diary: NonNullable<SettlePresentLoopValue['diary']>,
  now: number,
): string {
  const diaryId = context.idFactory('dream_');
  const volumeNo = currentVolumeNo(context.db, principal.userId, principal.catId);
  context.db
    .prepare(
      `INSERT INTO dream_diary_entries (
         diary_id, owner_user_id, dream_run_id, cat_id, local_date, written_at,
         status, doc_kind, entry_kind, trace_kind, tense_marker, volume_no,
         headline, summary, body_markdown, provenance_json, observations_json,
         produced_actions_json, created_by_invocation_id, source_thread_id,
         revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'published', 'diary', ?, ?, 'historical', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      diaryId,
      principal.userId,
      runId,
      principal.catId,
      diary.localDate,
      now,
      diary.entryKind,
      diary.traceKind,
      volumeNo,
      diary.headline,
      diary.summary,
      diary.bodyMarkdown,
      JSON.stringify(diary.provenance),
      JSON.stringify(diary.observations ?? []),
      JSON.stringify({ profileProposalIds: [], eventIds: [], provokeIds: [] }),
      principal.invocationId,
      principal.threadId,
      now,
      now,
    );
  insertCitations(context, principal.userId, diaryId, diary.provenance, now);
  context.db
    .prepare(
      `INSERT INTO dream_projection_state (
         owner_user_id, diary_id, product_revision, projected_revision
       ) VALUES (?, ?, 1, 0)`,
    )
    .run(principal.userId, diaryId);
  return diaryId;
}

function currentVolumeNo(db: Database.Database, ownerUserId: string, catId: string): number {
  const row = db
    .prepare(
      `SELECT MAX(volume_no) AS volume_no FROM dream_diary_entries
       WHERE owner_user_id = ? AND cat_id = ? AND sealed_at IS NULL`,
    )
    .get(ownerUserId, catId) as { volume_no: number | null };
  return row.volume_no ?? 1;
}

function insertCitations(
  context: AutoDreamStoreContext,
  ownerUserId: string,
  diaryId: string,
  refs: DreamEvidenceRefValue[],
  now: number,
): void {
  const statement = context.db.prepare(
    `INSERT OR IGNORE INTO dream_diary_citations (
       citation_id, owner_user_id, from_diary_id, to_kind, to_ref_id, resolver_json, cited_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const ref of refs) {
    statement.run(context.idFactory('citation_'), ownerUserId, diaryId, ref.kind, ref.refId, JSON.stringify(ref), now);
  }
}
