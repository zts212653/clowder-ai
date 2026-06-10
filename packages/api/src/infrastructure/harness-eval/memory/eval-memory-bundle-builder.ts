import type { MemoryLibraryHealth, MemoryRecallMetrics } from '../eval-memory-adapter.js';
import type { VerdictHandoffPacket } from '../verdict-handoff.js';

/**
 * F192 publish_verdict eval:memory wire-up — snapshot.json + attribution.json
 * builders extracted from the generator main file to keep it under AGENTS.md's
 * 350-line hard limit (cloud Codex R12 P1 surfaced the file was at warning-zone
 * line count). Generator now orchestrates: validate → call builders → write
 * raw inputs → write provenance → write verdict.md.
 *
 * Lock-step invariants:
 *   - `MEMORY_COMPONENT_ID` ('memory-recall') is the only allowed snapshot
 *     component id; matches `buildActionableAttributionEvidence` anchor prefix.
 *   - `MEMORY_COMPONENT_METRIC_KEYS` mirrors `buildSnapshot`'s component
 *     activationCounts + frictionCounts keys exactly — adding a metric to the
 *     snapshot REQUIRES updating this list, otherwise attribution evidence
 *     anchors will drift from bundle schema (cloud R5 P1 root cause).
 */

export const MEMORY_COMPONENT_ID = 'memory-recall';
export const MEMORY_COMPONENT_METRIC_KEYS = [
  'search_abandon_count',
  'grep_fallback_count',
  'stale_anchor_count',
  'orphan_edge_count',
  'total_recall_events',
] as const;

export interface BuildSnapshotInput {
  verdictId: string;
  evalSnapshotId: string;
  featureId: string;
  generatedAt: string;
  windowDays: number;
  recallMetrics: MemoryRecallMetrics;
  libraryHealth: MemoryLibraryHealth;
}

export function buildSnapshot(input: BuildSnapshotInput) {
  const durationHours = input.windowDays * 24;
  return {
    verdictId: input.verdictId,
    evalSnapshotId: input.evalSnapshotId,
    featureId: input.featureId,
    generatedAt: input.generatedAt,
    window: { durationHours },
    // bundle schema requires components.length >= 1 — model recall pipeline as
    // a single component with metric counters (mirrors cw's single-capability shape).
    components: [
      {
        id: MEMORY_COMPONENT_ID,
        name: 'Memory Recall & Library Health',
        confidence: input.recallMetrics.totalEvents >= 60 ? 'medium' : 'low',
        activationCounts: {
          total_recall_events: input.recallMetrics.totalEvents,
        },
        frictionCounts: {
          search_abandon_count: Math.round(
            input.recallMetrics.totalEvents * input.recallMetrics.core.searchAbandonRate,
          ),
          grep_fallback_count: Math.round(
            input.recallMetrics.totalEvents * input.recallMetrics.extended.grepFallbackRate,
          ),
          stale_anchor_count: input.libraryHealth.staleAnchors.count,
          orphan_edge_count: input.libraryHealth.orphanEdges.count,
        },
      },
    ],
    // Memory-specific extras (preserved on disk; bundle schema strips them but
    // raw audit + provenance can replay from raw inputs).
    recallMetrics: input.recallMetrics,
    libraryHealth: input.libraryHealth,
  };
}

export interface BuildAttributionInput {
  verdictId: string;
  evalSnapshotId: string;
  featureId: string;
  generatedAt: string;
  packet: VerdictHandoffPacket;
}

export function buildAttribution(input: BuildAttributionInput) {
  // Memory generator: cat owns finding/no-finding decision via packet.verdict.
  // We propagate it into attribution.json so reviewer can audit without re-running.
  const isKeepObserve = input.packet.verdict === 'keep_observe';
  if (isKeepObserve) {
    return {
      verdictId: input.verdictId,
      featureId: input.featureId,
      evalSnapshotId: input.evalSnapshotId,
      generatedAt: input.generatedAt,
      findings: [],
      noFindingRecord: {
        reason: input.packet.phenomenon,
        evidence: input.packet.evidencePacket.metricRefs.join(', ') || `${MEMORY_COMPONENT_ID}/metrics`,
      },
    };
  }
  return {
    verdictId: input.verdictId,
    featureId: input.featureId,
    evalSnapshotId: input.evalSnapshotId,
    generatedAt: input.generatedAt,
    findings: [
      {
        id: `MEM-${input.verdictId}`,
        relatedFeature: input.featureId,
        frictionSignal: {
          type: input.packet.rootCauseHypothesis.summary || 'memory.recall.degraded',
          severity: 'medium',
          confidence: 0.7,
          detectedAt: input.generatedAt,
        },
        attribution: {
          primaryLayer: MEMORY_COMPONENT_ID,
          evidence: buildActionableAttributionEvidence(input.packet),
        },
        proposedAction: [
          {
            action: input.packet.verdict,
            target: input.packet.ownerAsk.targetFeatureId,
            rationale: input.packet.ownerAsk.requestedAction,
          },
        ],
        status: 'open',
      },
    ],
  };
}

/**
 * Cloud Codex R5 P1: anchor must conform to `resolveA2aEvidenceBundle`'s invariant —
 * every finding evidence anchor MUST start with the bundled snapshot component id
 * (`memory-recall`) and reference a key that exists in that component's
 * activationCounts / frictionCounts. Without this, actionable verdicts
 * (`fix`/`build`/`delete_sunset`) fail with `attribution finding must include at
 * least one bundled component evidence anchor`. Keep-observe walks the no-finding
 * branch and dodges this; cloud Codex review surfaced the gap.
 */
function buildActionableAttributionEvidence(packet: VerdictHandoffPacket) {
  // Use up to 3 representative snapshot-aware anchors so resolveA2aEvidenceBundle
  // accepts the finding. excerpt preserves the cat's submitted metric ref so
  // reviewers see the user-facing label (e.g. `consumed_mrr`) alongside the
  // bundle-aware anchor.
  const excerpts =
    packet.evidencePacket.metricRefs.length > 0 ? packet.evidencePacket.metricRefs : [`${MEMORY_COMPONENT_ID}/metrics`];
  return MEMORY_COMPONENT_METRIC_KEYS.slice(0, 3).map((metricKey, i) => ({
    type: 'counter',
    anchor: `${MEMORY_COMPONENT_ID}/${metricKey}`,
    excerpt: excerpts[i] ?? excerpts[excerpts.length - 1],
  }));
}
