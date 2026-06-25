/**
 * F236 Phase A/B-Eval Track-1 — central recorder for anchor-first telemetry.
 *
 * F236 Phase A made the anchor-first callback read-tools return head/tail
 * previews + drill pointers instead of full bodies. The chars/volume signal
 * (returnedChars / fullDrillChars / request-response counts) was previously
 * emitted ONLY as `app.log.info(...)` — ephemeral stdout, lost in ~24h, with no
 * queryable consumer. Track-1 funnels the 4 emit sites through this recorder so
 * the same numbers ALSO land as OTel metrics (counter + histogram), giving a
 * queryable chars + request/response VOLUME substrate.
 *
 * Design mirrors `callback-auth-telemetry.ts`: an in-memory tally (testable via
 * `getAnchorTelemetrySnapshot()` + `resetAnchorTelemetryForTest()`) alongside
 * fire-and-forget OTel `.add()/.record()` calls. The OTel instrument shape lives
 * in `instruments.ts` (bound to the metric allowlist).
 *
 * CHARS + VOLUME SUBSTRATE ONLY (砚砚 eval-owner ruling iii) — this recorder
 * records returnedChars / fullDrillChars (the 省/savings signal) and per-tool
 * request/response volume counts. These are aggregate tallies with NO join keys,
 * so the recorder does NOT — and cannot — derive a per-tool drill↔preview
 * open-rate; that needs a cross-endpoint / per-item correlated event model and is
 * Track-2's scope. The 4 call sites keep their existing `app.log.info` (this is
 * additive observability).
 *
 * The 4 emit sites:
 *   1. routes/callbacks.ts            — pending-mentions  (preview)
 *   2. routes/callbacks.ts            — thread-context    (preview)
 *   3. routes/callback-task-routes.ts — list-tasks        (preview)
 *   4. routes/callbacks.ts            — get-message       (full drill, mode=full)
 */

import { ANCHOR_TOOL } from '../infrastructure/telemetry/genai-semconv.js';
import {
  anchorFullDrillChars,
  anchorFullDrillCount,
  anchorReturnedChars,
  anchorReturnedCount,
} from '../infrastructure/telemetry/instruments.js';

/** A preview-returning anchor tool. Bounded set keeps the metric label safe. */
export type AnchorPreviewTool = 'pending-mentions' | 'thread-context' | 'list-tasks';

export interface AnchorReturnedRecord {
  /** Which preview read-tool returned the payload. */
  tool: AnchorPreviewTool;
  /** Total chars of the returned (anchored) payload. */
  returnedChars: number;
}

/**
 * A full-drill anchor tool — serves the FULL body (not a preview):
 * `get-message` (mode=full) and `list-tasks` (taskId → that task's full why).
 * Recording these under drill volume (NOT preview-return volume) keeps the
 * per-tool request/response volume accounting honest: a `list-tasks?taskId`
 * full-why response is a drill-volume response, not a preview-volume response.
 * (This is volume categorization, not a drill/preview open-rate split — open-rate
 * is Track-2's scope, see module docstring.)
 */
export type AnchorDrillTool = 'get-message' | 'list-tasks';

export interface AnchorFullDrillRecord {
  /** Which tool served the full drill. */
  tool: AnchorDrillTool;
  /** Total chars served in the full drill. */
  fullDrillChars: number;
}

// --- In-memory tally (testable mirror of the OTel export) ---
let returnedByTool: Record<string, number> = {};
let returnedCharsByTool: Record<string, number> = {};
let drillByTool: Record<string, number> = {};
let drillCharsByTool: Record<string, number> = {};

/**
 * Record that an anchor-first preview payload was returned by `tool`.
 * Emits the OTel counter (occurrence) + histogram (returnedChars), both keyed
 * by the `anchor.tool` attribute, and updates the in-memory tally.
 */
export function recordAnchorReturned(record: AnchorReturnedRecord): void {
  returnedByTool[record.tool] = (returnedByTool[record.tool] ?? 0) + 1;
  returnedCharsByTool[record.tool] = (returnedCharsByTool[record.tool] ?? 0) + record.returnedChars;

  const attributes = { [ANCHOR_TOOL]: record.tool };
  anchorReturnedCount.add(1, attributes);
  anchorReturnedChars.record(record.returnedChars, attributes);
}

/**
 * Record that a full drill (full body served) happened, per tool —
 * `get-message` (mode=full) or `list-tasks` (taskId). Emits the OTel counter
 * + histogram (fullDrillChars) keyed by the `anchor.tool` attribute, and
 * updates the in-memory tally. Recording these separately from preview returns
 * keeps the per-tool request/response VOLUME accounting honest (drill-volume vs
 * preview-volume) — it is NOT an open-rate split (open-rate is Track-2's scope).
 */
export function recordAnchorFullDrill(record: AnchorFullDrillRecord): void {
  drillByTool[record.tool] = (drillByTool[record.tool] ?? 0) + 1;
  drillCharsByTool[record.tool] = (drillCharsByTool[record.tool] ?? 0) + record.fullDrillChars;

  const attributes = { [ANCHOR_TOOL]: record.tool };
  anchorFullDrillCount.add(1, attributes);
  anchorFullDrillChars.record(record.fullDrillChars, attributes);
}

export interface AnchorTelemetrySnapshot {
  /** Per-tool count of anchor preview payloads returned. */
  returnedByTool: Record<string, number>;
  /** Per-tool cumulative chars of returned anchor preview payloads. */
  returnedCharsByTool: Record<string, number>;
  /** Per-tool count of full drills served (get-message / list-tasks). */
  drillByTool: Record<string, number>;
  /** Per-tool cumulative chars served across full drills. */
  drillCharsByTool: Record<string, number>;
}

/**
 * Read the in-memory anchor telemetry tally. Chars + request/response volume
 * substrate only — intentionally NO derived ratio / open-rate field (open-rate
 * needs a correlated event model and is Track-2's scope, not computed here).
 */
export function getAnchorTelemetrySnapshot(): AnchorTelemetrySnapshot {
  return {
    returnedByTool: { ...returnedByTool },
    returnedCharsByTool: { ...returnedCharsByTool },
    drillByTool: { ...drillByTool },
    drillCharsByTool: { ...drillCharsByTool },
  };
}

/** Test-only — reset internal counters between cases. NEVER call from prod code. */
export function resetAnchorTelemetryForTest(): void {
  returnedByTool = {};
  returnedCharsByTool = {};
  drillByTool = {};
  drillCharsByTool = {};
}

// Track-2 (per-event model with correlation keys + open-rate rollup) has been
// extracted to ./anchor-event-log.ts (cloud R3 P1: 350-line file cap).
