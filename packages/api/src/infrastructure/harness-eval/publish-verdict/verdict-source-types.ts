/**
 * F192 Phase H — Verdict source selector types (discriminated union members).
 *
 * Extracted from types.ts per 350-line hard limit. Each selector carries the
 * replayable identity for a specific eval domain. The union `VerdictSourceRefs`
 * is the handler's discriminator — generator adapters dispatch on `kind`.
 *
 * @module
 */
import type { FrictionRollupSourceSelector } from '@cat-cafe/shared';
import type { CapabilityWakeupSourceSelector } from '../capability-wakeup/capability-wakeup-trial-provider.js';
import type { DesignGateEpisodeSourceSelector } from '../design-gate/design-gate-types.js';
import type { FreshnessReplaySelector } from '../freshness/freshness-replay-types.js';
import type { QcMetricsSelector } from '../qc-metrics-provider.js';
import type { SopTraceInput } from '../sop/sop-trace-adapter.js';
import type { TaskOutcomeVerdict } from '../task-outcome/task-outcome-episode.js';
import type { TrajectoryInspectorWindowSelector } from '../trajectory-inspector/trajectory-inspector-types.js';

/**
 * a2a evidence refs — basenames of pre-sanitized YAML files. `kind` is OPTIONAL
 * for backward compat (existing cats publish without specifying kind, default
 * interpretation is a2a snapshot/attribution refs).
 *
 * 砚砚 R2 P2 cloud: must be basename (NOT path) — handler resolves under allowlist.
 */
export interface A2aSnapshotAttributionRefs {
  kind?: 'a2a-snapshot-attribution';
  /** Basename of sanitized eval snapshot YAML inside `<harnessFeedbackRoot>/snapshots/`. */
  snapshotName?: string;
  /** Basename of sanitized attribution YAML inside `<harnessFeedbackRoot>/attributions/`. */
  attributionName?: string;
}

/**
 * F192 PR1 — task-outcome replayable snapshot selector. The real generator is
 * not wired yet; PR1 only reserves the schema/type surface so handler + MCP
 * tool can validate the shape honestly before PR2 flips the wire.
 */
export interface TaskOutcomeSnapshotSourceRefs {
  kind: 'task-outcome-snapshot';
  windowStartMs: number;
  windowEndMs: number;
  databasePath?: string;
  evidenceCatId?: string;
  /**
   * Optional explicit 7-class episode verdict writeback. Packet-level verdict
   * remains the shared 4-class harness judgement; these entries are per-episode
   * labels assigned by the eval cat after reading the replay window.
   */
  episodeVerdicts?: Array<{
    episodeId: string;
    verdict: TaskOutcomeVerdict;
  }>;
}

/**
 * F192 publish_verdict eval:memory wire-up — replayable recall metrics selector.
 * Provider (`MemoryMetricsProvider`) resolves selector → live recall metrics +
 * library health snapshot. Generator writes them into bundle/snapshot.json +
 * raw inputs at `<repoRoot>/generated/memory/<verdictId>/`.
 */
export interface MemoryRecallSourceSelector {
  kind: 'memory-recall-snapshot';
  /** Inclusive window in days [1, 90] — recall API ceiling. */
  windowDays: number;
  /** Optional — restrict to a specific cat id. */
  catId?: string;
  /** Optional — restrict to a specific recall tool. */
  toolName?: string;
}

/**
 * F192 sop-wiring — replayable SOP trace selector. Eval cat builds the trace
 * from session observation; generator replays evaluation via predicate evaluator
 * and writes provenance artifacts. Trace is embedded (no persistent SOP trace
 * store yet), so the selector carries the full SopTraceInput.
 */
export interface SopTraceSourceSelector {
  kind: 'sop-trace-eval';
  /** Which SOP definition to evaluate against (e.g. 'development'). */
  sopDefinitionId: string;
  /** The full trace data for deterministic replay. */
  trace: SopTraceInput;
}

/**
 * F236 Track-2 AC-E4 — replayable anchor telemetry rollup selector for eval:anchor-first.
 * Provider resolves this window selector → getAnchorTelemetryRollup(window) → rollup
 * snapshot with per-tool open-rate, charsSaved, drillChars, double-sided netBenefit.
 * Shape mirrors FrictionRollupSourceSelector (window + kind discriminator).
 */
export interface AnchorTelemetrySourceSelector {
  kind: 'anchor-telemetry-snapshot';
  /** Window start (inclusive), epoch ms */
  windowStartMs: number;
  /** Window end (exclusive), epoch ms; must be > windowStartMs */
  windowEndMs: number;
}

/**
 * F192 Phase H 收尾 PR-2 — `VerdictSourceRefs` is a discriminated union (砚砚 R1 Q3).
 * - a2a branch: `{snapshotName, attributionName}` (kind optional, default a2a)
 * - capability-wakeup branch: `CapabilityWakeupSourceSelector` (kind required)
 * - task-outcome branch: `TaskOutcomeSnapshotSourceRefs` (kind required, PR1 schema-only)
 * - memory branch: `MemoryRecallSourceSelector` (kind required, memory wire-up)
 * - sop branch: `SopTraceSourceSelector` (kind required, sop-wiring)
 * - friction branch: `FrictionRollupSourceSelector` (kind required, F245 PR1b live sink)
 * - anchor-telemetry branch: `AnchorTelemetrySourceSelector` (kind required, F236 Track-2)
 * - qc branch: `QcMetricsSelector` (kind required, F253 Phase C)
 * - freshness branch: `FreshnessReplaySelector` (kind required, F254 AC-E9)
 *
 * 砚砚 R1 P1 #2: generator MUST receive explicit `sources` (sanitized
 * evidence refs / replayable selector); tool NEVER fabricates evidence.
 */
export type VerdictSourceRefs =
  | A2aSnapshotAttributionRefs
  | CapabilityWakeupSourceSelector
  | TaskOutcomeSnapshotSourceRefs
  | MemoryRecallSourceSelector
  | SopTraceSourceSelector
  | FrictionRollupSourceSelector
  | AnchorTelemetrySourceSelector
  | QcMetricsSelector
  | FreshnessReplaySelector
  | DesignGateEpisodeSourceSelector
  | TrajectoryInspectorWindowSelector;
