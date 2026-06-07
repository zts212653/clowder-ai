/**
 * F211 REG10 PR1 — read-only incremental reader over the Antigravity SQLite step store.
 *
 * AGY CLI persists each conversation's trajectory steps to a local SQLite db
 * (`<appDataDir>/conversations/<conversationId>.db`, table `steps`, idx PK + payload blob).
 * NOTE (PR2A mapping proof, docs/features/assets/F211/2026-06-02-reg10-carrier-mapping-proof.md): the
 * IDE Desktop carrier keeps its ACTIVE cascade in LS memory and does NOT persist it here, so this reader
 * serves the AGY CLI carrier / already-persisted conversations, NOT the IDE Desktop active cascade.
 * This reader returns an O(delta) incremental view (`idx >= lastSeen - tailWindow`) so callers
 * can track long-task progress without re-fetching the whole trajectory (REG9's O(N) per change).
 *
 * PR1 scope (L1 only): expose step metadata (idx/type/status/payloadBytes) — does NOT decode the
 * protobuf `step_payload` (that is PR2). Schema drift / missing db / unreadable db / invalid id all
 * fail CLOSED so the caller can fall back to REG9 status-poll instead of trusting a partial store.
 *
 * Opened read-only with query_only + busy_timeout and WITHOUT sqlite `immutable=1`, so a live
 * SQLite WAL writer's committed updates remain visible (immutable=1 would freeze the snapshot).
 *
 * Boundary inputs are validated before use (codex review P1/P2): conversationId is restricted to a
 * pure basename (no path separators / `..`) so it cannot traverse out of `conversations/`; tailWindow
 * and busyTimeoutMs are normalized to safe integers; a non-integer cursor degrades to first-read.
 */

import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import Database from 'better-sqlite3';

export interface AntigravityStepRow {
  idx: number;
  stepType: number;
  status: number;
  /** byte length of the protobuf step_payload blob; PR1 does NOT decode the payload. */
  payloadBytes: number;
}

export type StepStoreReadResult =
  | { ok: true; steps: AntigravityStepRow[]; maxIdx: number }
  | { ok: false; reason: 'no_db' | 'schema_drift' | 'read_error' | 'invalid_id' };

export interface StepStoreReaderOptions {
  /** AGY CLI app data dir, e.g. `~/.gemini/antigravity-cli` — the persisted/CLI conversation store, NOT the IDE Desktop active cascade (see PR2A mapping proof). */
  appDataDir: string;
  /** Re-read the last N steps each poll to catch in-place status/payload mutation. Default 3. */
  tailWindow?: number;
  /** SQLite busy timeout (ms) for the read-only connection. Default 2000. */
  busyTimeoutMs?: number;
}

export const STEP_STORE_DEFAULT_TAIL_WINDOW = 3;
export const STEP_STORE_DEFAULT_BUSY_TIMEOUT_MS = 2000;

/** Columns the reader relies on; any missing → schema drift → fail closed → caller falls back to REG9. */
const REQUIRED_STEP_COLUMNS = ['idx', 'step_type', 'status', 'step_payload', 'step_format'];

/** tailWindow must be a non-negative integer; anything else (negative / NaN / float) → default. */
function normalizeTailWindow(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : STEP_STORE_DEFAULT_TAIL_WINDOW;
}

/** busyTimeoutMs must be a positive integer (it is interpolated into a PRAGMA); else → default. */
function normalizeBusyTimeoutMs(value: number | undefined): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : STEP_STORE_DEFAULT_BUSY_TIMEOUT_MS;
}

/**
 * conversationId must be a pure basename (no path separators, no `..`, no NUL). This prevents a
 * caller-supplied id like `../outside` from escaping `conversations/` and reading an arbitrary `.db`.
 */
function isValidConversationId(id: string): boolean {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    !id.includes('/') &&
    !id.includes('\\') &&
    !id.includes('..') &&
    !id.includes('\0') &&
    basename(id) === id
  );
}

export class AntigravityStepStoreReader {
  private readonly appDataDir: string;
  private readonly tailWindow: number;
  private readonly busyTimeoutMs: number;

  constructor(options: StepStoreReaderOptions) {
    this.appDataDir = options.appDataDir;
    this.tailWindow = normalizeTailWindow(options.tailWindow);
    this.busyTimeoutMs = normalizeBusyTimeoutMs(options.busyTimeoutMs);
  }

  /**
   * Read steps with index >= max(0, cursor - tailWindow) for tail-overlap re-read (re-reads the last
   * tailWindow already-seen steps plus lastSeen itself, so in-place status/payload mutation is caught).
   * lastSeenIdx === null (or non-integer) → first read, returns all steps from idx 0.
   * Fails closed {ok:false} on invalid id / missing db / schema drift / unreadable db.
   */
  readSince(conversationId: string, lastSeenIdx: number | null): StepStoreReadResult {
    if (!isValidConversationId(conversationId)) {
      return { ok: false, reason: 'invalid_id' };
    }
    if (typeof this.appDataDir !== 'string' || this.appDataDir.length === 0) {
      return { ok: false, reason: 'no_db' };
    }
    // Non-integer cursor degrades to first-read (safe: never skips steps).
    const cursor = lastSeenIdx === null || !Number.isInteger(lastSeenIdx) ? null : lastSeenIdx;

    const dbPath = join(this.appDataDir, 'conversations', `${conversationId}.db`);
    if (!existsSync(dbPath)) {
      return { ok: false, reason: 'no_db' };
    }

    let db: Database.Database | undefined;
    try {
      // readonly + query_only + busy_timeout; NOT immutable → live WAL updates stay visible.
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      db.pragma('query_only = true');
      db.pragma(`busy_timeout = ${this.busyTimeoutMs}`);

      // schema drift (missing table / columns) is a distinct, expected fail-closed reason.
      if (!this.hasStepsSchema(db)) {
        return { ok: false, reason: 'schema_drift' };
      }

      const lowerBound = cursor === null ? 0 : Math.max(0, cursor - this.tailWindow);
      const rows = db
        .prepare(
          'SELECT idx, step_type AS stepType, status, length(step_payload) AS payloadBytes FROM steps WHERE idx >= ? ORDER BY idx',
        )
        .all(lowerBound) as Array<{ idx: number; stepType: number; status: number; payloadBytes: number | null }>;

      const steps: AntigravityStepRow[] = rows.map((r) => ({
        idx: r.idx,
        stepType: r.stepType,
        status: r.status,
        payloadBytes: r.payloadBytes ?? 0,
      }));
      const maxIdx = steps.length > 0 ? (steps[steps.length - 1]?.idx ?? -1) : -1;
      return { ok: true, steps, maxIdx };
    } catch {
      // Open/pragma/query threw (corrupt db, lock timeout, unexpected shape) → read_error,
      // kept distinct from schema_drift so the caller can tell "malformed store" from "different schema".
      return { ok: false, reason: 'read_error' };
    } finally {
      db?.close();
    }
  }

  private hasStepsSchema(db: Database.Database): boolean {
    const cols = db.prepare("SELECT name FROM pragma_table_info('steps')").all() as Array<{ name: string }>;
    if (cols.length === 0) return false; // no `steps` table at all
    const names = new Set(cols.map((c) => c.name));
    return REQUIRED_STEP_COLUMNS.every((c) => names.has(c));
  }
}
