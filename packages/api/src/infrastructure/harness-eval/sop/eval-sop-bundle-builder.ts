import type { VerdictHandoffPacket } from '../verdict-handoff.js';
import type { SopEvalResult } from './sop-predicate-evaluator.js';
import type { SopTrace } from './sop-trace-adapter.js';

/**
 * F192 sop-wiring: snapshot.json + attribution.json builders for eval:sop.
 *
 * Mirrors eval-memory-bundle-builder.ts pattern: domain-specific data mapped
 * INTO the shared a2a bundle schema so `resolveA2aEvidenceBundle` (used by
 * eval-hub-read-model.ts for ALL domains) can parse it. SOP-specific extras
 * (sopDefinitionId, violations detail, ruleResults) preserved on disk but the
 * required bundle fields (evalSnapshotId, window, components, findings) are
 * the contract that Hub reads.
 *
 * Lock-step invariants:
 *   - `SOP_COMPONENT_ID` ('sop-compliance') is the only allowed snapshot
 *     component id; attribution finding evidence anchors must reference it.
 *   - Component activationCounts + frictionCounts keys must stay in sync
 *     with attribution evidence anchors (cloud R5 P1 pattern from memory).
 */

export const SOP_COMPONENT_ID = 'sop-compliance';

/** Weekly eval window = 336 hours (14 days). */
const WEEKLY_WINDOW_HOURS = 336;

export interface BuildSopSnapshotInput {
  verdictId: string;
  evalSnapshotId: string;
  featureId: string;
  generatedAt: string;
  trace: SopTrace;
  evalResults: readonly SopEvalResult[];
}

export function buildSopSnapshot(input: BuildSopSnapshotInput) {
  const violations = input.evalResults.filter((r) => r.status === 'violation');
  const passed = input.evalResults.filter((r) => r.status === 'pass');
  const skipped = input.evalResults.filter((r) => r.status === 'skipped');

  return {
    verdictId: input.verdictId,
    evalSnapshotId: input.evalSnapshotId,
    featureId: input.featureId,
    generatedAt: input.generatedAt,
    window: { durationHours: WEEKLY_WINDOW_HOURS },
    // Bundle schema requires components.length >= 1 — model SOP compliance as
    // a single component with rule-pass/violation/skipped counters.
    components: [
      {
        id: SOP_COMPONENT_ID,
        name: `SOP ${input.trace.sopDefinitionId} / ${input.trace.observedStage}`,
        confidence: input.evalResults.length >= 5 ? 'medium' : ('low' as const),
        activationCounts: {
          rules_passed: passed.length,
          rules_evaluated: input.evalResults.length,
        },
        frictionCounts: {
          violations_blocker: violations.filter((v) => v.violation?.severity === 'blocker').length,
          violations_warn: violations.filter((v) => v.violation?.severity === 'warn').length,
          rules_skipped: skipped.length,
        },
      },
    ],
    // SOP-specific extras (preserved on disk; bundle schema strips unknown fields
    // but raw audit + provenance can replay from raw inputs).
    sopDefinitionId: input.trace.sopDefinitionId,
    observedStage: input.trace.observedStage,
    sessionId: input.trace.sessionId,
  };
}

export interface BuildSopAttributionInput {
  verdictId: string;
  evalSnapshotId: string;
  featureId: string;
  generatedAt: string;
  trace: SopTrace;
  evalResults: readonly SopEvalResult[];
  packet: VerdictHandoffPacket;
}

export function buildSopAttribution(input: BuildSopAttributionInput) {
  const violations = input.evalResults.filter((r) => r.status === 'violation');
  const isClean = violations.length === 0;

  if (isClean) {
    return {
      verdictId: input.verdictId,
      featureId: input.featureId,
      evalSnapshotId: input.evalSnapshotId,
      generatedAt: input.generatedAt,
      findings: [],
      noFindingRecord: {
        reason: input.packet.phenomenon,
        evidence: input.packet.evidencePacket.metricRefs.join(', ') || `${SOP_COMPONENT_ID}/rules_passed`,
      },
    };
  }

  // Map each violation to a finding conforming to attributionFindingSchema.
  return {
    verdictId: input.verdictId,
    featureId: input.featureId,
    evalSnapshotId: input.evalSnapshotId,
    generatedAt: input.generatedAt,
    findings: violations.map((v, i) => ({
      id: `SOP-${input.verdictId}-${i}`,
      relatedFeature: input.featureId,
      frictionSignal: {
        type: v.violation?.predicateType ?? 'sop.violation',
        severity: mapSopSeverity(v.violation?.severity),
        confidence: 0.9,
        detectedAt: input.generatedAt,
      },
      attribution: {
        primaryLayer: SOP_COMPONENT_ID,
        evidence: buildSopAttributionEvidence(v),
      },
      proposedAction: [
        {
          action: input.packet.verdict,
          target: input.packet.ownerAsk.targetFeatureId,
          rationale: v.violation?.message ?? input.packet.ownerAsk.requestedAction,
        },
      ],
      status: 'open',
    })),
  };
}

/**
 * Map SOP severity ('blocker'|'warning') to attribution schema severity
 * ('low'|'medium'|'high').
 */
function mapSopSeverity(severity: string | undefined): 'low' | 'medium' | 'high' {
  if (severity === 'blocker') return 'high';
  if (severity === 'warn') return 'medium';
  return 'low';
}

/**
 * Build attribution evidence anchors referencing the SOP component's
 * frictionCounts keys, so `resolveA2aEvidenceBundle` accepts the finding.
 */
function buildSopAttributionEvidence(result: SopEvalResult) {
  const severity = result.violation?.severity ?? 'warn';
  const countKey = severity === 'blocker' ? 'violations_blocker' : 'violations_warn';
  return [
    {
      type: 'sop-violation',
      anchor: `${SOP_COMPONENT_ID}/${countKey}`,
      excerpt: `${result.ruleId}: ${result.violation?.message ?? 'violation detected'}`,
    },
  ];
}
