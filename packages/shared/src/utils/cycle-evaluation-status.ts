import type { CycleEvaluationStatus } from '../types/harness-evaluation.js';

/**
 * F257 evaluation-cycle status predicates shared by the API guards and the
 * Console UI, so both sides gate on one truth.
 *
 * `stalled` is not a terminal state. It means both bounded automatic nudges
 * (the single 30-minute retrigger, then the stall alert) were spent without a
 * structured writeback and the system stopped prompting. The cycle keeps two
 * human-driven exits:
 *   1. a late evaluation writeback from the Objective thread — the trace pool
 *      and `submit_cycle_evaluation` stay open, and the writeback flows into
 *      governance exactly as an on-time one would;
 *   2. an operator version transition (switch or create) — it terminates the
 *      cycle with `manual-version-switch` provenance and opens the next one,
 *      which needs no evaluator cat at all.
 */
export function cycleAcceptsEvaluationWriteback(status: CycleEvaluationStatus): boolean {
  return status === 'requested' || status === 'retriggered' || status === 'stalled';
}

/**
 * `requested` / `retriggered` / `written` protect an evaluation or governance
 * step that is still in flight; `idle` and `stalled` have nothing in flight.
 */
export function cycleAcceptsOperatorVersionTransition(status: CycleEvaluationStatus): boolean {
  return status === 'idle' || status === 'stalled';
}
