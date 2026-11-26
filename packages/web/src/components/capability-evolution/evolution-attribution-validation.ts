import { isOwnerRef } from './evolution-lineage';

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
function layer(value: unknown): boolean {
  const item = record(value);
  return (
    !!item &&
    ['execution', 'harness', 'rubric', 'observation'].includes(String(item.layer)) &&
    typeof item.label === 'string'
  );
}

export function isAttribution(value: unknown): value is EvolutionAttributionExplanation {
  const item = record(value);
  if (
    !item ||
    item.schemaVersion !== 1 ||
    !['attributed', 'unresolved', 'insufficient', 'incomparable'].includes(String(item.verdict)) ||
    typeof item.headline !== 'string'
  )
    return false;
  const confidence = record(item.confidence);
  const comparability = record(item.comparability);
  const gate = record(item.gate);
  return (
    (item.primaryLayer === undefined || layer(item.primaryLayer)) &&
    Array.isArray(item.evidence) &&
    item.evidence.every((raw) => {
      const evidence = record(raw);
      return (
        isOwnerRef(raw) &&
        !!evidence &&
        typeof evidence.label === 'string' &&
        typeof evidence.identity === 'string' &&
        (evidence.assetKind === undefined || typeof evidence.assetKind === 'string') &&
        (evidence.assetId === undefined || typeof evidence.assetId === 'string')
      );
    }) &&
    Array.isArray(item.competingAttributions) &&
    item.competingAttributions.every((raw) => layer(raw) && typeof record(raw)?.discriminating === 'boolean') &&
    Array.isArray(item.notAssessedLayers) &&
    item.notAssessedLayers.every(layer) &&
    strings(item.whyNotChange) &&
    !!confidence &&
    ['interval', 'power', 'not_estimable', 'unknown'].includes(String(confidence.basis)) &&
    typeof confidence.label === 'string' &&
    (confidence.ownerStateRef === undefined || typeof confidence.ownerStateRef === 'string') &&
    !!comparability &&
    ['comparable', 'incomparable'].includes(String(comparability.status)) &&
    typeof comparability.label === 'string' &&
    !!gate &&
    ['pending', 'blocked', 'ready'].includes(String(gate.status)) &&
    Array.isArray(gate.blockers) &&
    gate.blockers.every((raw) => {
      const blocker = record(raw);
      return (
        !!blocker &&
        typeof blocker.code === 'string' &&
        typeof blocker.label === 'string' &&
        typeof blocker.ownerFeatureId === 'string'
      );
    })
  );
}

/**
 * F311 Phase 3 — F307 Attribution panel (AC-34).
 *
 * Pure projection of the API-side attribution explanation: current evidence, competing
 * attributions, confidence bound, the layers nobody looked at, and why we are not changing
 * anything yet. It renders owner refs, never owner payload, and it holds no state of its own.
 */

export type EvolutionAttributionLayer = 'execution' | 'harness' | 'rubric' | 'observation';

export interface EvolutionAttributionExplanation {
  schemaVersion: 1;
  verdict: 'attributed' | 'unresolved' | 'insufficient' | 'incomparable';
  headline: string;
  primaryLayer?: { layer: EvolutionAttributionLayer; label: string };
  evidence: Array<{
    label: string;
    ownerFeatureId: string;
    ownerStateRef: string;
    version?: string;
    assetKind?: string;
    assetId?: string;
    /** Collision-free identity: rubric v3 and v4 are two entries, not one duplicated key. */
    identity: string;
  }>;
  competingAttributions: Array<{ layer: EvolutionAttributionLayer; label: string; discriminating: boolean }>;
  notAssessedLayers: Array<{ layer: EvolutionAttributionLayer; label: string }>;
  confidence: { basis: 'interval' | 'power' | 'not_estimable' | 'unknown'; label: string; ownerStateRef?: string };
  comparability: { status: 'comparable' | 'incomparable'; label: string };
  whyNotChange: string[];
  /**
   * Tri-state: an attribution with no gate evaluation yet is "pending", never "ready"; only a
   * canonical intervention_linked event opens Change Review.
   */
  gate: {
    status: 'pending' | 'blocked' | 'ready';
    blockers: Array<{ code: string; label: string; ownerFeatureId: string }>;
  };
}
