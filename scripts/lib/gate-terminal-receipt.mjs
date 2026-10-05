import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { assertSourceFullBrowserGreen } from './gate-browser-evidence.mjs';
import { GATE_EXECUTION_PATHS } from './gate-execution-paths.mjs';
import { openGateResourcePool } from './gate-resource-db.mjs';
import {
  assertGateStagesGreen,
  ensureGateStageReceiptTables,
  GATE_STAGES,
  invalidatePostPauseGateStageReceiptsInTransaction,
  readGateStageReceipts,
} from './gate-stage-receipts.mjs';
import {
  assertSourceFullIdentity,
  gateInvocationScope,
  gateRunHasScope,
  gateVerificationScope,
} from './gate-verification-scope.mjs';
import { inspectLeaseOwner } from './redis-test-leases.mjs';

const TERMINAL_STATUSES = new Set(['green', 'failed', 'cancelled', 'timed_out', 'lost', 'partial']);
const REUSABLE_STATUS = 'green';
export const DEFAULT_GATE_TERMINAL_WAIT_MS = 3 * 60 * 60_000;
export { GATE_EXECUTION_PATHS } from './gate-execution-paths.mjs';

const GATE_CONFIG_PATHS = ['package.json', 'pnpm-workspace.yaml', 'biome.json', '.nvmrc'];

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function gateFingerprintFromComponents(components) {
  return sha256(stableJson(components));
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function digestFiles(repoRoot, relativePaths) {
  return Object.fromEntries(
    relativePaths.map((relativePath) => {
      const absolutePath = path.join(repoRoot, relativePath);
      return [relativePath, existsSync(absolutePath) ? sha256(readFileSync(absolutePath)) : null];
    }),
  );
}

export function computeGateFingerprint(repoRoot, argv = []) {
  const { verificationScope, sourceSha } = gateInvocationScope(argv);
  const dirty = git(repoRoot, ['status', '--porcelain', '--untracked-files=all']);
  if (dirty) throw new Error('canonical full-gate receipt requires a clean exact tree');
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const pnpmVersion = execFileSync('pnpm', ['--version'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  const components = {
    tree: git(repoRoot, ['rev-parse', 'HEAD^{tree}']),
    lockfileSha256: sha256(readFileSync(path.join(repoRoot, 'pnpm-lock.yaml'))),
    toolchain: { node: process.version, pnpm: pnpmVersion, packageManager: packageJson.packageManager ?? null },
    gateCode: digestFiles(repoRoot, GATE_EXECUTION_PATHS),
    gateConfig: digestFiles(repoRoot, GATE_CONFIG_PATHS),
    invocation: { argv, ...(sourceSha ? { verificationScope, sourceSha } : {}) },
  };
  return { fingerprint: gateFingerprintFromComponents(components), components };
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

function openRunStore(databasePath) {
  const database = openGateResourcePool(databasePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS gate_runs (
      run_id TEXT PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      job_id TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      owner_started_at TEXT NOT NULL,
      state TEXT NOT NULL,
      terminal_status TEXT,
      created_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      terminal_at INTEGER,
      result_json TEXT,
      frozen_identity_json TEXT,
      execution_owner_job_id TEXT,
      execution_origin_task_id TEXT,
      execution_used_ms INTEGER NOT NULL DEFAULT 0,
      execution_slice_started_at INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS gate_runs_one_active_producer
      ON gate_runs(fingerprint) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS gate_runs_green_lookup
      ON gate_runs(fingerprint, terminal_status, terminal_at);
    CREATE TABLE IF NOT EXISTS gate_run_reuse_invalidations (
      run_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      terminal_at INTEGER NOT NULL,
      pause_epoch INTEGER NOT NULL,
      reconcile_from INTEGER NOT NULL,
      invalidated_at INTEGER NOT NULL,
      reason TEXT NOT NULL,
      PRIMARY KEY (run_id, pause_epoch),
      FOREIGN KEY (run_id) REFERENCES gate_runs(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS gate_run_reuse_invalidations_lookup
      ON gate_run_reuse_invalidations(fingerprint, run_id);
  `);
  const ensureColumn = (name, definition) => {
    const hasColumn = () =>
      database
        .prepare('PRAGMA table_info(gate_runs)')
        .all()
        .some((column) => column.name === name);
    if (hasColumn()) return;
    try {
      database.exec(`ALTER TABLE gate_runs ADD COLUMN ${name} ${definition}`);
    } catch (error) {
      if (!hasColumn()) throw error;
    }
  };
  ensureColumn('execution_used_ms', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('execution_slice_started_at', 'INTEGER');
  ensureColumn('frozen_identity_json', 'TEXT');
  ensureColumn('execution_owner_job_id', 'TEXT');
  ensureColumn('execution_origin_task_id', 'TEXT');
  ensureGateStageReceiptTables(database);
  return database;
}

function publicRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    fingerprint: row.fingerprint,
    jobId: row.job_id,
    ownerIdentity: { pid: row.owner_pid, startedAt: row.owner_started_at },
    state: row.state,
    terminalStatus: row.terminal_status,
    createdAt: row.created_at,
    heartbeatAt: row.heartbeat_at,
    terminalAt: row.terminal_at,
    reuseEligible: row.reuse_eligible === undefined ? true : Boolean(row.reuse_eligible),
    result: row.result_json ? JSON.parse(row.result_json) : null,
    frozenIdentity: row.frozen_identity_json ? JSON.parse(row.frozen_identity_json) : null,
    executionOwnerJobId: row.execution_owner_job_id ?? null,
    executionOriginTaskId: row.execution_origin_task_id ?? null,
    executionUsedMs: row.execution_used_ms,
    executionSliceStartedAt: row.execution_slice_started_at,
  };
}

function invalidatePostPauseGateRunsInTransaction(database, { fingerprint, reconcileFrom, pauseEpoch, now }) {
  const runs = database
    .prepare(
      `SELECT run_id, fingerprint, terminal_at FROM gate_runs
       WHERE fingerprint = ? AND state = 'terminal' AND terminal_status = 'green' AND terminal_at >= ?`,
    )
    .all(fingerprint, reconcileFrom);
  const insert = database.prepare(
    `INSERT OR IGNORE INTO gate_run_reuse_invalidations
      (run_id, fingerprint, terminal_at, pause_epoch, reconcile_from, invalidated_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, 'sleep-recovery-boundary')`,
  );
  for (const run of runs) {
    insert.run(run.run_id, run.fingerprint, run.terminal_at, pauseEpoch, reconcileFrom, now);
  }
  return runs.map((run) => run.run_id);
}

function assertRunScope(row, expected, terminal) {
  const run = publicRun(row);
  const matches = terminal
    ? gateRunHasScope(run, expected)
    : gateVerificationScope(run.frozenIdentity?.verificationScope) === expected;
  if (!matches) throw new Error('gate reuse verificationScope changed for the same fingerprint');
}

export function beginGateRun({
  databasePath,
  fingerprint,
  ownerIdentity,
  jobId,
  executionOwnerJobId = null,
  executionOriginTaskId = null,
  frozenIdentity = null,
  recoveryBoundary = null,
  now = Date.now(),
  inspectProcess = inspectLeaseOwner,
}) {
  const verificationScope = gateVerificationScope(frozenIdentity?.verificationScope);
  if (frozenIdentity) assertSourceFullIdentity(frozenIdentity);
  const database = openRunStore(databasePath);
  try {
    return transaction(database, () => {
      if (recoveryBoundary !== null) {
        invalidatePostPauseGateStageReceiptsInTransaction(database, {
          expectedFingerprint: fingerprint,
          reconcileFrom: recoveryBoundary.reconcileFrom,
          pauseEpoch: recoveryBoundary.pauseEpoch,
          now,
        });
        invalidatePostPauseGateRunsInTransaction(database, {
          fingerprint,
          reconcileFrom: recoveryBoundary.reconcileFrom,
          pauseEpoch: recoveryBoundary.pauseEpoch,
          now,
        });
      }
      const reusable = database
        .prepare(`SELECT * FROM gate_runs
          WHERE fingerprint = ? AND state = 'terminal' AND terminal_status = ?
            AND (? IS NULL OR terminal_at < ?)
            AND NOT EXISTS (
              SELECT 1 FROM gate_run_reuse_invalidations AS invalidation
              WHERE invalidation.run_id = gate_runs.run_id
            )
          ORDER BY terminal_at DESC LIMIT 1`)
        .get(
          fingerprint,
          REUSABLE_STATUS,
          recoveryBoundary?.reconcileFrom ?? null,
          recoveryBoundary?.reconcileFrom ?? null,
        );
      if (reusable) {
        assertRunScope(reusable, verificationScope, true);
        return { role: 'reused', runId: reusable.run_id, fingerprint, terminalStatus: REUSABLE_STATUS };
      }

      const active = database
        .prepare("SELECT * FROM gate_runs WHERE fingerprint = ? AND state = 'active'")
        .get(fingerprint);
      if (active) {
        assertRunScope(active, verificationScope, false);
        const inspection = inspectProcess({ pid: active.owner_pid, startedAt: active.owner_started_at });
        if (inspection.status !== 'dead') {
          return { role: 'follower', runId: active.run_id, fingerprint };
        }
        database
          .prepare(
            "UPDATE gate_runs SET state = 'terminal', terminal_status = 'lost', terminal_at = ?, heartbeat_at = ? WHERE run_id = ? AND state = 'active'",
          )
          .run(now, now, active.run_id);
      }

      const runId = randomUUID();
      database
        .prepare(
          `INSERT INTO gate_runs
            (run_id, fingerprint, job_id, owner_pid, owner_started_at, state, created_at, heartbeat_at,
             frozen_identity_json, execution_owner_job_id, execution_origin_task_id)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
        )
        .run(
          runId,
          fingerprint,
          jobId,
          ownerIdentity.pid,
          ownerIdentity.startedAt,
          now,
          now,
          frozenIdentity === null ? null : JSON.stringify(frozenIdentity),
          executionOwnerJobId,
          executionOriginTaskId,
        );
      return { role: 'producer', runId, fingerprint };
    });
  } finally {
    database.close();
  }
}

export function heartbeatGateRun(databasePath, runId, ownerIdentity, now = Date.now()) {
  const database = openRunStore(databasePath);
  try {
    const result = database
      .prepare(
        "UPDATE gate_runs SET heartbeat_at = ? WHERE run_id = ? AND state = 'active' AND owner_pid = ? AND owner_started_at = ?",
      )
      .run(now, runId, ownerIdentity.pid, ownerIdentity.startedAt);
    return result.changes === 1;
  } finally {
    database.close();
  }
}

export function beginGateExecutionSlice(databasePath, jobId, executionSlaMs, now = Date.now()) {
  const database = openRunStore(databasePath);
  try {
    return transaction(database, () => {
      const run = database
        .prepare("SELECT * FROM gate_runs WHERE job_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1")
        .get(jobId);
      if (!run) return null;
      const carriedMs =
        run.execution_slice_started_at === null
          ? run.execution_used_ms
          : run.execution_used_ms + Math.max(0, now - run.execution_slice_started_at);
      const remainingMs = Math.max(0, executionSlaMs - carriedMs);
      if (remainingMs <= 0) return { runId: run.run_id, remainingMs: 0, executionUsedMs: carriedMs };
      database
        .prepare(
          'UPDATE gate_runs SET execution_used_ms = ?, execution_slice_started_at = ?, heartbeat_at = ? WHERE run_id = ?',
        )
        .run(carriedMs, now, now, run.run_id);
      return { runId: run.run_id, remainingMs, executionUsedMs: carriedMs };
    });
  } finally {
    database.close();
  }
}

export function finishGateExecutionSlice(databasePath, jobId, now = Date.now()) {
  const database = openRunStore(databasePath);
  try {
    return transaction(database, () => {
      const run = database
        .prepare("SELECT * FROM gate_runs WHERE job_id = ? AND state = 'active' ORDER BY created_at DESC LIMIT 1")
        .get(jobId);
      if (!run || run.execution_slice_started_at === null) return null;
      const executionUsedMs = run.execution_used_ms + Math.max(0, now - run.execution_slice_started_at);
      database
        .prepare(
          'UPDATE gate_runs SET execution_used_ms = ?, execution_slice_started_at = NULL, heartbeat_at = ? WHERE run_id = ?',
        )
        .run(executionUsedMs, now, run.run_id);
      return { runId: run.run_id, executionUsedMs };
    });
  } finally {
    database.close();
  }
}

export function settleGateRun({ databasePath, runId, status, result = null, requiredStages = null, now = Date.now() }) {
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`invalid gate terminal status: ${status}`);
  if (status === 'green') {
    const run = readGateRun(databasePath, runId);
    if (gateVerificationScope(run?.frozenIdentity?.verificationScope) === 'source_full') {
      assertGateStagesGreen(
        databasePath,
        runId,
        GATE_STAGES.filter((stage) => stage !== 'test-public'),
      );
      if (result?.verificationScope !== 'source_full')
        throw new Error('source_full terminal verificationScope changed');
      assertSourceFullBrowserGreen(
        run.frozenIdentity,
        result,
        readGateStageReceipts(databasePath, runId).find((stage) => stage.stage === 'test-web-browser'),
      );
    } else {
      assertGateStagesGreen(databasePath, runId, requiredStages);
    }
  }
  const database = openRunStore(databasePath);
  try {
    return transaction(database, () => {
      const settled = database
        .prepare(
          "UPDATE gate_runs SET state = 'terminal', terminal_status = ?, terminal_at = ?, heartbeat_at = ?, result_json = ? WHERE run_id = ? AND state = 'active'",
        )
        .run(status, now, now, result === null ? null : JSON.stringify(result), runId);
      return settled.changes === 1;
    });
  } finally {
    database.close();
  }
}

export function readGateRun(databasePath, runId) {
  const database = openRunStore(databasePath);
  try {
    return publicRun(
      database
        .prepare(
          `SELECT run.*, NOT EXISTS (
             SELECT 1 FROM gate_run_reuse_invalidations AS invalidation
             WHERE invalidation.run_id = run.run_id
           ) AS reuse_eligible
           FROM gate_runs AS run WHERE run.run_id = ?`,
        )
        .get(runId),
    );
  } finally {
    database.close();
  }
}

export function readGateRunTelemetry(databasePath, runId) {
  const run = readGateRun(databasePath, runId);
  if (!run) return null;
  const result = run.result ?? {};
  return {
    runId,
    route: result.route ?? null,
    fullGateCount: Number.isSafeInteger(result.fullGateCount) ? result.fullGateCount : null,
    failedStage: result.failedStage ?? null,
    failure: result.failure ?? null,
    stages: readGateStageReceipts(databasePath, runId).map((receipt) => ({
      stage: receipt.stage,
      durationMs: Number.isFinite(receipt.evidence?.durationMs) ? receipt.evidence.durationMs : null,
      rerunRelation: receipt.completedRunId === runId ? 'executed' : 'reused',
      completedRunId: receipt.completedRunId,
    })),
  };
}

// Eligibility is an exact-fingerprint fact, not a paginated history projection.
export function hasBlockingGateEvidence(databasePath, fingerprint) {
  if (typeof fingerprint !== 'string' || !fingerprint) throw new Error('gate fingerprint is required');
  if (!existsSync(databasePath)) return false;
  const database = openRunStore(databasePath);
  try {
    return Boolean(
      database
        .prepare(`SELECT EXISTS (
      SELECT 1 FROM gate_runs AS run WHERE run.fingerprint = ? AND (
        run.state <> 'terminal' OR run.terminal_status IS NOT 'green' OR EXISTS (
          SELECT 1 FROM gate_run_reuse_invalidations AS invalidation
          WHERE invalidation.run_id = run.run_id
        )
      )
    ) AS blocked`)
        .get(fingerprint).blocked,
    );
  } finally {
    database.close();
  }
}

export function listGateRuns(databasePath, { limit = 200 } = {}) {
  if (!existsSync(databasePath)) return [];
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2_000) {
    throw new Error(`invalid gate run limit: ${limit}`);
  }
  const database = openRunStore(databasePath);
  try {
    return database
      .prepare(
        `SELECT run.*, NOT EXISTS (
           SELECT 1 FROM gate_run_reuse_invalidations AS invalidation
           WHERE invalidation.run_id = run.run_id
         ) AS reuse_eligible
         FROM gate_runs AS run ORDER BY run.created_at DESC LIMIT ?`,
      )
      .all(limit)
      .map(publicRun);
  } finally {
    database.close();
  }
}

export function projectMainHealthReceipt(runs, commits, maxCandidates = 12) {
  const greenByTree = new Map();
  for (const run of runs) {
    if (
      run.terminalStatus !== 'green' ||
      run.reuseEligible === false ||
      !gateRunHasScope(run, 'merge') ||
      !run.result?.treeSha ||
      greenByTree.has(run.result.treeSha)
    )
      continue;
    greenByTree.set(run.result.treeSha, run);
  }
  const head = commits[0] ?? null;
  const exactRun = head ? (greenByTree.get(head.treeSha) ?? null) : null;
  const lastGreenIndex = commits.findIndex((commit) => greenByTree.has(commit.treeSha));
  const lastGreenCommit = lastGreenIndex >= 0 ? commits[lastGreenIndex] : null;
  const lastGreenRun = lastGreenCommit ? greenByTree.get(lastGreenCommit.treeSha) : null;
  const bisectCandidates =
    lastGreenIndex > 0
      ? commits
          .slice(0, lastGreenIndex)
          .reverse()
          .slice(-maxCandidates)
          .map((commit) => commit.headSha)
      : [];
  return {
    availability: 'available',
    headSha: head?.headSha ?? null,
    treeSha: head?.treeSha ?? null,
    receipt: exactRun ? { runId: exactRun.runId, terminalAt: exactRun.terminalAt } : null,
    lastGreen: lastGreenCommit && lastGreenRun ? { headSha: lastGreenCommit.headSha, runId: lastGreenRun.runId } : null,
    bisectCandidates,
  };
}

export async function waitForGateRunTerminal(
  databasePath,
  runId,
  { pollMs = 250, waitMs = DEFAULT_GATE_TERMINAL_WAIT_MS } = {},
) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const run = readGateRun(databasePath, runId);
    if (!run) throw new Error(`gate run disappeared: ${runId}`);
    if (run.state === 'terminal') return run;
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
  throw new Error(`timed out waiting for gate producer ${runId}`);
}
