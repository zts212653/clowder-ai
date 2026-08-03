export const TURN_CUSTODY_SHADOW_DISAGREEMENT_EVENT_NAME = 'turn_custody.shadow_disagreement';
export const TURN_CUSTODY_UNKNOWN_AGREE_BLOCK_EVENT_NAME = 'turn_custody.unknown_legacy_agree_block';
export const TURN_CUSTODY_SHADOW_SAMPLE_SPAN = 'cat_cafe.a2a.turn_custody_shadow_sample';

// F167 Phase T: bounded metric dimensions. Keep these namespaced so adding
// them to the F152 global allowlist cannot accidentally admit unrelated
// generic `state` / `comparison` attributes.
export const TURN_CUSTODY_METRIC_STATE_ATTR = 'turn_custody.state';
export const TURN_CUSTODY_METRIC_COMPARISON_ATTR = 'turn_custody.comparison';
export const TURN_CUSTODY_METRIC_CLASSIFICATION_ATTR = 'turn_custody.classification';

// PrometheusExporter normalizes dots in OTel attribute names to underscores.
// The eval consumes scrape text, so pin that external label contract here.
export const TURN_CUSTODY_PROMETHEUS_STATE_LABEL = 'turn_custody_state';
export const TURN_CUSTODY_PROMETHEUS_COMPARISON_LABEL = 'turn_custody_comparison';
export const TURN_CUSTODY_PROMETHEUS_CLASSIFICATION_LABEL = 'turn_custody_classification';

// Trace-only disagreement sample attribute; metric allowlisting does not apply.
export const TURN_CUSTODY_PROJECTION_STATE_ATTR = 'projectionState';
export const TURN_CUSTODY_CLOSE_CHECKPOINT_ATTR = 'closeCheckpoint';
export const TURN_CUSTODY_WAKE_PROVENANCE_ATTR = 'wakeProvenance';
export const TURN_CUSTODY_TRANSITION_OBSERVED_ATTR = 'transitionObserved';
export const TURN_CUSTODY_PROJECTION_REASON_ATTR = 'projectionReason';
export const TURN_CUSTODY_SOURCE_CATEGORY_ATTR = 'sourceCategory';
export const TURN_CUSTODY_SOURCE_SEMANTIC_ATTR = 'sourceSemantic';

export type TurnCustodyNewOnlyClassification = 'justified' | 'unjustified' | 'unexplained' | 'not_applicable';

type TurnCustodyCloseCheckpoint = 'next_turn_boundary' | 'route_settled';

interface TurnCustodyNewOnlyEvidence {
  readonly comparison: string;
  readonly state: string;
  readonly projectionReason: string;
  readonly sourceCategory: string;
  readonly sourceSemantic: string;
  readonly wakeProvenance: string;
  readonly closeCheckpoint: string;
  readonly transitionObserved: boolean;
}

const TURN_CUSTODY_OBLIGATION_SOURCE_SEMANTICS = new Set([
  'not_recorded',
  'cross_thread_investigate',
  'cross_thread_assign_work',
]);

const TURN_CUSTODY_LEGACY_CONNECTOR_SOURCE_CATEGORIES = new Set(['ci', 'review', 'conflict', 'issue', 'continuation']);

const TURN_CUSTODY_STRUCTURED_WAKE_SOURCE_CATEGORIES = new Map([
  ['structured:dispatch', 'a2a'],
  ['structured:assign_work', 'a2a'],
  ['structured:coordination', 'a2a'],
  ['structured:callback', 'a2a'],
  ['structured:hold', 'scheduled'],
  ['structured:event_wait', 'scheduled'],
]);

function hasStableTurnCustodyCheckpoint(value: string): value is TurnCustodyCloseCheckpoint {
  return value === 'next_turn_boundary' || value === 'route_settled';
}

function hasCoherentStructuredWake(input: TurnCustodyNewOnlyEvidence): boolean {
  return TURN_CUSTODY_STRUCTURED_WAKE_SOURCE_CATEGORIES.get(input.wakeProvenance) === input.sourceCategory;
}

function hasCoherentActiveObligation(input: TurnCustodyNewOnlyEvidence): boolean {
  if (input.projectionReason !== 'not_applicable') return false;
  if (!TURN_CUSTODY_OBLIGATION_SOURCE_SEMANTICS.has(input.sourceSemantic)) return false;
  if (input.wakeProvenance === 'action_successor') {
    return input.sourceCategory === 'action_successor' && input.sourceSemantic === 'not_recorded';
  }
  return hasCoherentStructuredWake(input);
}

function hasExplainedFailClosedProjection(input: TurnCustodyNewOnlyEvidence): boolean {
  if (input.sourceSemantic !== 'not_recorded') return false;
  if (input.projectionReason === 'action_holder_mismatch') {
    return input.sourceCategory === 'action_successor' && input.wakeProvenance === 'action_successor';
  }
  if (input.projectionReason === 'structured_holder_mismatch') return hasCoherentStructuredWake(input);
  if (input.projectionReason === 'carrier_missing') {
    return (
      input.wakeProvenance === 'legacy:carrier_missing' &&
      TURN_CUSTODY_LEGACY_CONNECTOR_SOURCE_CATEGORIES.has(input.sourceCategory)
    );
  }
  return false;
}

/**
 * Partition every new-only block at the authoritative decision point.
 *
 * This is deliberately derived from the same bounded machine evidence emitted
 * for diagnosis, never from post-hoc prose or trace availability. Known active
 * obligations and known fail-closed mismatch families are justified only when
 * their provenance is coherent. Contradictory state is unjustified; incomplete
 * or incoherent evidence remains unexplained.
 */
export function classifyTurnCustodyNewOnlyBlock(input: TurnCustodyNewOnlyEvidence): TurnCustodyNewOnlyClassification {
  if (input.comparison !== 'new_only_block') return 'not_applicable';
  if (input.transitionObserved || input.state === 'covered_empty') return 'unjustified';
  if (!hasStableTurnCustodyCheckpoint(input.closeCheckpoint)) return 'unexplained';
  if (input.state === 'covered_active') {
    return hasCoherentActiveObligation(input) ? 'justified' : 'unexplained';
  }
  if (input.state === 'unknown_legacy') {
    return hasExplainedFailClosedProjection(input) ? 'justified' : 'unexplained';
  }
  return 'unexplained';
}

export interface LegacyRoutingObservationInput {
  readonly lineStartMentions: readonly string[];
  readonly toolNames: readonly string[];
  readonly structuredTargetCats: readonly string[];
  readonly hasCoCreatorLineStartMention?: boolean;
  readonly hasTerminalCoordinationExit?: boolean;
}

/**
 * Historical behavior-delta observer used only by Phase T telemetry.
 *
 * It has no blocking authority and no remedial prompt. Keeping the old decision
 * as an observation lets projected_block_increase_total remain interpretable
 * while the F177 text guard itself is deleted.
 */
export function observesLegacyRoutingBlock(input: LegacyRoutingObservationInput): boolean {
  if (input.hasTerminalCoordinationExit) return false;
  if (input.lineStartMentions.length > 0) return false;
  if (input.structuredTargetCats.length > 0) return false;
  if (input.hasCoCreatorLineStartMention) return false;
  if (
    input.toolNames.some((name) => {
      const lower = name.toLowerCase();
      return lower.includes('hold_ball') || lower.includes('multi_mention');
    })
  ) {
    return false;
  }
  return true;
}

const TURN_CUSTODY_PROJECTION_REASONS = new Set([
  'text_mention',
  'source_missing',
  'carrier_missing',
  'query_failed',
  'action_store_unavailable',
  'action_lease_missing',
  'action_generation_mismatch',
  'action_terminal',
  'action_holder_mismatch',
  'structured_store_unavailable',
  'structured_projection_missing',
  'structured_holder_mismatch',
  'dispatch_handoff_missing',
]);

const TURN_CUSTODY_SOURCE_CATEGORIES = new Set([
  'user',
  'ci',
  'review',
  'conflict',
  'scheduled',
  'a2a',
  'continuation',
  'issue',
  'freshness',
  'action_successor',
  'unknown',
]);

const TURN_CUSTODY_SOURCE_SEMANTICS = new Set([
  'cross_thread_fyi',
  'cross_thread_coordinate',
  'cross_thread_investigate',
  'cross_thread_assign_work',
  'coordination_terminal',
  'not_recorded',
]);

export function turnCustodyProjectionReason(evidenceRefs: readonly string[]): string {
  for (let index = evidenceRefs.length - 1; index >= 0; index -= 1) {
    const evidenceRef = evidenceRefs[index];
    if (!evidenceRef?.startsWith('unknown:')) continue;
    const reason = evidenceRef.slice('unknown:'.length);
    return TURN_CUSTODY_PROJECTION_REASONS.has(reason) ? reason : 'other';
  }
  return 'not_applicable';
}

export function boundedTurnCustodySourceCategory(sourceCategory: string | undefined): string {
  if (!sourceCategory) return 'unknown';
  return TURN_CUSTODY_SOURCE_CATEGORIES.has(sourceCategory) ? sourceCategory : 'unknown';
}

export function boundedTurnCustodySourceSemantic(sourceSemantic: string | undefined): string {
  if (!sourceSemantic) return 'not_recorded';
  return TURN_CUSTODY_SOURCE_SEMANTICS.has(sourceSemantic) ? sourceSemantic : 'not_recorded';
}

export function turnCustodySourceSemantic(input: {
  readonly terminalCoordination: boolean;
  readonly effectClass?: string;
}): string {
  if (input.terminalCoordination) return 'coordination_terminal';
  return boundedTurnCustodySourceSemantic(input.effectClass ? `cross_thread_${input.effectClass}` : 'not_recorded');
}
