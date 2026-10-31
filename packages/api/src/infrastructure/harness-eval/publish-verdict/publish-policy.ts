import type { VerdictHandoffPacket } from '../verdict-handoff.js';

/**
 * F192 Phase H 收尾 PR-3 — auto-verdict publish-policy classifier (砚砚 R2 design-lock).
 *
 * Why: PR-2 dogfood (PR #2114) surfaced that EVERY scheduled eval verdict opens a regular
 * PR — including `keep_observe + noFindingRecord` runs that need no action. operator asked
 * "who merges this?" and the answer "you" is wrong product-shape. This policy separates:
 *   - Real workspace PRs (owner action) — `regular_pr`
 *   - Low-noise evidence artifacts (cat-owned merge) — `evidence_only_interim_pr`
 *
 * `evidence_only_interim_pr` is INTERIM — it still opens a PR (PR-3 doesn't ship rollup
 * mechanism). `futureMode: 'rollup_deferred'` documents the design-intent end state
 * (rollup all no-action verdicts into daily/weekly archive PR; or runtime evidence store
 * + scheduled flush). Naming this honestly avoids 砚砚 R2 critique: don't return enum
 * `rollup_deferred` as executable behavior when no rollup sink exists.
 *
 * 砚砚 R2 FAIL-OPEN rule: any attribution shape ambiguity → `regular_pr`. Misclassifying
 * actionable evidence as "no-action" is worse than misclassifying noise as actionable
 * (false positive = extra cat work; false negative = missed signal goes silent).
 */

export type PublishPolicy =
  | { mode: 'regular_pr'; labels: string[]; cvoMergeRequired: false }
  | {
      mode: 'evidence_only_interim_pr';
      labels: ['evidence-only', 'no-action-needed'];
      cvoMergeRequired: false;
      /** Design-intent target state — NOT implemented in PR-3. Documents that a rollup
       *  mechanism (daily/weekly batch PR OR runtime evidence store) should replace
       *  per-run interim PRs in a future Phase. */
      futureMode: 'rollup_deferred';
    };

/**
 * Pure classifier — no I/O. Caller (publish-verdict handler) reads attribution.json from
 * the generator's bundleDir post-generation and passes it here alongside the packet.
 */
export function computePublishPolicy(packet: VerdictHandoffPacket, attribution: unknown): PublishPolicy {
  // Severity ladder: non-keep_observe verdicts ALWAYS need owner action — regardless
  // of attribution shape. Don't let attribution noise downgrade a `fix` to interim.
  if (packet.verdict !== 'keep_observe') {
    return { mode: 'regular_pr', labels: [], cvoMergeRequired: false };
  }

  // keep_observe → inspect attribution to decide regular_pr (actionable) vs interim (no-action).
  // 砚砚 R2 FAIL-OPEN: any structural ambiguity → regular_pr.
  if (!attribution || typeof attribution !== 'object') {
    return { mode: 'regular_pr', labels: [], cvoMergeRequired: false };
  }
  const attr = attribution as Record<string, unknown>;
  const findings = attr.findings;
  const noFindingRecord = attr.noFindingRecord;

  // FAIL-OPEN: findings must be array if present
  if (findings !== undefined && !Array.isArray(findings)) {
    return { mode: 'regular_pr', labels: [], cvoMergeRequired: false };
  }
  // FAIL-OPEN: noFindingRecord must be a record (object, non-null, NOT array) if present.
  // 砚砚 R1 PR-3 review P2: `typeof [] === 'object'` slips arrays through plain typeof
  // check; Array.isArray() rejection prevents `noFindingRecord: []` misclassification.
  if (
    noFindingRecord !== undefined &&
    (typeof noFindingRecord !== 'object' || noFindingRecord === null || Array.isArray(noFindingRecord))
  ) {
    return { mode: 'regular_pr', labels: [], cvoMergeRequired: false };
  }
  // FAIL-OPEN: contradiction (both findings.length > 0 AND noFindingRecord) → regular_pr
  // so reviewer investigates the inconsistency.
  const hasFindings = Array.isArray(findings) && findings.length > 0;
  const hasNoFindingRecord = noFindingRecord !== undefined && noFindingRecord !== null;
  if (hasFindings && hasNoFindingRecord) {
    return { mode: 'regular_pr', labels: [], cvoMergeRequired: false };
  }

  // keep_observe + actionable findings → regular PR with evidence-only label
  // (cat-owned merge per artifact-merge-gate SOP, not operator).
  if (hasFindings) {
    return { mode: 'regular_pr', labels: ['evidence-only'], cvoMergeRequired: false };
  }

  // keep_observe + noFindingRecord (no actionable signal) → interim PR.
  // PR-3 still opens a PR (rollup sink not implemented); labels + body footer
  // flag it as no-action artifact for cat-owned merge.
  if (hasNoFindingRecord) {
    return {
      mode: 'evidence_only_interim_pr',
      labels: ['evidence-only', 'no-action-needed'],
      cvoMergeRequired: false,
      futureMode: 'rollup_deferred',
    };
  }

  // Empty findings array AND no noFindingRecord → unusual; fail-open to regular_pr.
  return { mode: 'regular_pr', labels: [], cvoMergeRequired: false };
}
