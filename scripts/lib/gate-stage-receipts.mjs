import { openGateResourcePool } from './gate-resource-db.mjs';

export const GATE_STAGES = Object.freeze([
  'tsc',
  'test-public',
  'test-non-browser',
  'test-web-unit',
  'test-web-browser',
  'test-web-guards',
  'lint-web',
  'check',
]);

const GATE_STAGE_SET = new Set(GATE_STAGES);
const INVALIDATION_REASONS = new Set(['tree-fingerprint-drift']);
const GATE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SOURCE_REF_PATTERN = /^thread_[A-Za-z0-9_-]+#[A-Za-z0-9_-]+$/;

function assertKnownStage(stage) {
  if (!GATE_STAGE_SET.has(stage)) throw new Error(`unknown gate stage: ${stage}`);
}

function openStageStore(databasePath) {
  const database = openGateResourcePool(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS gate_stage_receipts (
      fingerprint TEXT NOT NULL,
      stage TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status = 'green'),
      completed_run_id TEXT NOT NULL,
      completed_at INTEGER NOT NULL,
      evidence_json TEXT,
      PRIMARY KEY (fingerprint, stage)
    );
    CREATE TABLE IF NOT EXISTS gate_stage_receipt_invalidations (
      fingerprint TEXT NOT NULL,
      stage TEXT NOT NULL,
      completed_run_id TEXT NOT NULL,
      completed_at INTEGER NOT NULL,
      evidence_json TEXT,
      invalidated_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      PRIMARY KEY (fingerprint, stage, completed_run_id)
    );
  `);
  return database;
}

function transaction(database, action) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function publicReceipt(row) {
  if (!row) return null;
  return {
    fingerprint: row.fingerprint,
    stage: row.stage,
    status: row.status,
    completedRunId: row.completed_run_id,
    completedAt: row.completed_at,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
  };
}

function publicInvalidation(row) {
  return {
    fingerprint: row.fingerprint,
    stage: row.stage,
    completedRunId: row.completed_run_id,
    completedAt: row.completed_at,
    evidence: row.evidence_json ? JSON.parse(row.evidence_json) : null,
    invalidatedAt: row.invalidated_at,
    reason: row.reason,
    sourceRef: row.source_ref,
  };
}

export function markGateStageGreen({
  databasePath,
  runId,
  stage,
  ownerIdentity,
  expectedFingerprint,
  evidence = null,
  now = Date.now(),
}) {
  assertKnownStage(stage);
  if (!ownerIdentity?.pid || !ownerIdentity.startedAt) throw new Error('gate stage writer identity is required');
  if (typeof expectedFingerprint !== 'string' || !expectedFingerprint) {
    throw new Error('gate stage writer fingerprint is required');
  }
  const database = openStageStore(databasePath);
  try {
    return transaction(database, () => {
      const run = database
        .prepare(
          "SELECT fingerprint FROM gate_runs WHERE run_id = ? AND fingerprint = ? AND state = 'active' AND owner_pid = ? AND owner_started_at = ?",
        )
        .get(runId, expectedFingerprint, ownerIdentity.pid, ownerIdentity.startedAt);
      if (!run) return false;
      database
        .prepare(
          `INSERT INTO gate_stage_receipts
            (fingerprint, stage, status, completed_run_id, completed_at, evidence_json)
           VALUES (?, ?, 'green', ?, ?, ?)
           ON CONFLICT(fingerprint, stage) DO UPDATE SET
             completed_run_id = excluded.completed_run_id,
             completed_at = excluded.completed_at,
             evidence_json = excluded.evidence_json`,
        )
        .run(run.fingerprint, stage, runId, now, evidence === null ? null : JSON.stringify(evidence));
      return true;
    });
  } finally {
    database.close();
  }
}

export function invalidateGateStageReceipts({
  databasePath,
  runId,
  expectedFingerprint,
  reason,
  sourceRef,
  now = Date.now(),
}) {
  if (typeof expectedFingerprint !== 'string' || !GATE_FINGERPRINT_PATTERN.test(expectedFingerprint)) {
    throw new Error('stage receipt invalidation requires an exact fingerprint');
  }
  if (!INVALIDATION_REASONS.has(reason)) throw new Error(`unknown stage receipt invalidation reason: ${reason}`);
  if (typeof sourceRef !== 'string' || !SOURCE_REF_PATTERN.test(sourceRef)) {
    throw new Error('stage receipt invalidation requires an exact source ref');
  }
  const database = openStageStore(databasePath);
  try {
    return transaction(database, () => {
      const run = database
        .prepare(
          "SELECT fingerprint FROM gate_runs WHERE run_id = ? AND fingerprint = ? AND state = 'terminal' AND terminal_status <> 'green'",
        )
        .get(runId, expectedFingerprint);
      if (!run) throw new Error('stage receipt invalidation target must be the exact non-green terminal run');
      const receipts = database
        .prepare('SELECT * FROM gate_stage_receipts WHERE fingerprint = ? AND completed_run_id = ? ORDER BY stage ASC')
        .all(expectedFingerprint, runId);
      const insert = database.prepare(
        `INSERT OR IGNORE INTO gate_stage_receipt_invalidations
          (fingerprint, stage, completed_run_id, completed_at, evidence_json, invalidated_at, reason, source_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const receipt of receipts) {
        insert.run(
          receipt.fingerprint,
          receipt.stage,
          receipt.completed_run_id,
          receipt.completed_at,
          receipt.evidence_json,
          now,
          reason,
          sourceRef,
        );
      }
      database
        .prepare('DELETE FROM gate_stage_receipts WHERE fingerprint = ? AND completed_run_id = ?')
        .run(expectedFingerprint, runId);
      return {
        fingerprint: expectedFingerprint,
        runId,
        invalidatedStages: receipts.map((receipt) => receipt.stage),
      };
    });
  } finally {
    database.close();
  }
}

export function readGateStageReceiptInvalidations(databasePath, runId) {
  const database = openStageStore(databasePath);
  try {
    return database
      .prepare(
        'SELECT * FROM gate_stage_receipt_invalidations WHERE completed_run_id = ? ORDER BY invalidated_at ASC, stage ASC',
      )
      .all(runId)
      .map(publicInvalidation);
  } finally {
    database.close();
  }
}

export function readGateStageReceipt(databasePath, runId, stage) {
  assertKnownStage(stage);
  const database = openStageStore(databasePath);
  try {
    return publicReceipt(
      database
        .prepare(
          `SELECT receipt.* FROM gate_runs AS run
           JOIN gate_stage_receipts AS receipt ON receipt.fingerprint = run.fingerprint
           WHERE run.run_id = ? AND receipt.stage = ? AND receipt.status = 'green'`,
        )
        .get(runId, stage),
    );
  } finally {
    database.close();
  }
}

export function readGateStageReceipts(databasePath, runId) {
  const database = openStageStore(databasePath);
  try {
    return database
      .prepare(
        `SELECT receipt.* FROM gate_runs AS run
         JOIN gate_stage_receipts AS receipt ON receipt.fingerprint = run.fingerprint
         WHERE run.run_id = ? AND receipt.status = 'green'
         ORDER BY receipt.completed_at ASC, receipt.stage ASC`,
      )
      .all(runId)
      .map(publicReceipt);
  } finally {
    database.close();
  }
}

export function assertGateStagesGreen(databasePath, runId, stages) {
  if (!Array.isArray(stages) || stages.length === 0) {
    throw new Error('terminal-green settlement requires at least one gate stage');
  }
  const requiredStages = [...new Set(stages)];
  requiredStages.forEach(assertKnownStage);
  const database = openStageStore(databasePath);
  try {
    const run = database.prepare("SELECT fingerprint FROM gate_runs WHERE run_id = ? AND state = 'active'").get(runId);
    if (!run) throw new Error(`active gate run not found: ${runId}`);
    const greenStages = new Set(
      database
        .prepare("SELECT stage FROM gate_stage_receipts WHERE fingerprint = ? AND status = 'green'")
        .all(run.fingerprint)
        .map((row) => row.stage),
    );
    const missing = requiredStages.filter((stage) => !greenStages.has(stage));
    if (missing.length > 0) throw new Error(`missing green gate stages: ${missing.join(', ')}`);
    return true;
  } finally {
    database.close();
  }
}
