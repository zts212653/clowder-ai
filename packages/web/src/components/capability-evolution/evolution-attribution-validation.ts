import type { EvolutionAttributionExplanation } from './EvolutionAttributionPanel';
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
