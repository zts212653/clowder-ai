/**
 * F257 V1 — DeviationEvent data model.
 *
 * Semantics single source of truth: F257 redesign §3.1 (union schema +
 * attribution rules) + T-C §3.6 (manual incidentKey) + §3.1 v1.8 note
 * (condition incidentKey owner namespace). Comments cite spec sections only —
 * definitions live in the spec, not here.
 */

import { createHash } from 'node:crypto';

export interface UnitRef {
  /** §4.8②: must be a registered UnitTypeAdapter type (V1 registry = V1_ALLOWED_UNIT_TYPES) */
  unitType: string;
  unitId: string;
}

export interface DeviationAttribution {
  objectiveId: string;
  unitRefs: UnitRef[];
  weight: number;
}

export interface DeviationAnchors {
  threadId: string;
  messageId?: string;
  invocationId?: string;
}

export type ManualObservationSource = 'operator' | 'peer' | 'self';

/** T-C sourceAnchor typed union. */
export type DeviationSourceAnchor =
  | { kind: 'thread_message'; messageId: string }
  | { kind: 'operator_confirmation'; confirmationId: string };

/** §3.1 公共字段. */
interface DeviationEventCommon {
  eventId: string;
  timestamp: number;
  registryVersion: string;
  incidentKey: string;
  ownerUserId: string;
  attributions: DeviationAttribution[];
  anchors: DeviationAnchors;
  subjectCatId: string;
}

export interface ConditionHitEvent extends DeviationEventCommon {
  kind: 'condition_hit';
  conditionId: string;
  sourceFactRef: string;
  recordedBy: 'system';
}

export interface ManualObservationEvent extends DeviationEventCommon {
  kind: 'manual_observation';
  source: ManualObservationSource;
  note: string;
  sourceAnchor: DeviationSourceAnchor;
  /** T-C: principal-injected, never self-reported */
  recordedBy: string;
}

export type DeviationEvent = ConditionHitEvent | ManualObservationEvent;

/** §6 切片 V1: no condition registry exists yet — V1 manual events carry this marker. */
export const V1_REGISTRY_VERSION = 'none';

/** §3.1: registered UnitTypeAdapter set (V1 仅 'segment'). */
export const V1_ALLOWED_UNIT_TYPES: ReadonlySet<string> = new Set(['segment']);

const SEP = '\u0000'; // never appears in ids - composite strings cannot collide

function anchorIdentity(anchor: DeviationSourceAnchor): string {
  return anchor.kind === 'thread_message'
    ? `thread_message${SEP}${anchor.messageId}`
    : `operator_confirmation${SEP}${anchor.confirmationId}`;
}

/** T-C: canonical (objectiveId, unitType, unitId) tuple set — server-sorted, weight excluded. */
function canonicalAttributionTuples(attributions: DeviationAttribution[]): string[] {
  const tuples: string[] = [];
  for (const a of attributions) {
    for (const ref of a.unitRefs) {
      tuples.push(`${a.objectiveId}${SEP}${ref.unitType}${SEP}${ref.unitId}`);
    }
  }
  return tuples.sort();
}

/** T-C incidentKey (manual branch). */
export function manualIncidentKey(
  ownerUserId: string,
  sourceAnchor: DeviationSourceAnchor,
  subjectCatId: string,
  attributions: DeviationAttribution[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'manual',
        ownerUserId,
        anchorIdentity(sourceAnchor),
        subjectCatId,
        canonicalAttributionTuples(attributions),
      ]),
    )
    .digest('hex');
}

/** §3.1 v1.8: condition_hit incidentKey — owner-namespaced. */
export function conditionIncidentKey(ownerUserId: string, conditionId: string, sourceFactRef: string): string {
  return createHash('sha256')
    .update(JSON.stringify(['condition', ownerUserId, conditionId, sourceFactRef]))
    .digest('hex');
}

/**
 * §3.1 attribution + per-kind rules. Returns human-readable violations
 * (empty = valid). Store-level guard — the ledger never persists an event
 * that violates the schema contract.
 */
export function validateDeviationEvent(
  event: DeviationEvent,
  allowedUnitTypes: ReadonlySet<string> = V1_ALLOWED_UNIT_TYPES,
): string[] {
  const errors: string[] = [];
  if (!event.eventId) errors.push('eventId required');
  if (!Number.isFinite(event.timestamp)) errors.push('timestamp must be a finite number');
  if (!event.registryVersion) errors.push('registryVersion required');
  if (!event.incidentKey) errors.push('incidentKey required');
  if (!event.ownerUserId) errors.push('ownerUserId required');
  if (!event.anchors?.threadId) errors.push('anchors.threadId required');
  if (!event.subjectCatId) errors.push('subjectCatId required');

  const attrs = event.attributions ?? [];
  if (attrs.length === 0) errors.push('attributions must be non-empty');
  const seenObjectives = new Set<string>();
  for (const a of attrs) {
    if (!a.objectiveId) errors.push('attribution.objectiveId required');
    if (seenObjectives.has(a.objectiveId)) errors.push(`duplicate objectiveId: ${a.objectiveId}`);
    seenObjectives.add(a.objectiveId);
    if (!a.unitRefs || a.unitRefs.length === 0) errors.push('attribution.unitRefs must be non-empty');
    for (const ref of a.unitRefs ?? []) {
      if (!allowedUnitTypes.has(ref.unitType)) errors.push(`unitType not registered: ${ref.unitType}`);
      if (!ref.unitId) errors.push('unitRef.unitId required');
    }
    if (typeof a.weight !== 'number' || !(a.weight > 0) || a.weight > 1) {
      errors.push(`attribution.weight must be in (0,1]: ${String(a.weight)}`);
    }
  }

  if (event.kind === 'condition_hit') {
    if (attrs.length !== 1) errors.push('condition_hit requires exactly one attribution');
    if (attrs.length === 1 && attrs[0].weight !== 1) errors.push('condition_hit attribution.weight must be 1.0');
    if (event.recordedBy !== 'system') errors.push('condition_hit recordedBy must be "system"');
    if (!event.conditionId) errors.push('conditionId required');
    if (!event.sourceFactRef) errors.push('sourceFactRef required');
  } else if (event.kind === 'manual_observation') {
    if (!event.note) errors.push('note required');
    if (!event.recordedBy) errors.push('recordedBy required');
    if (!event.sourceAnchor) errors.push('sourceAnchor required');
  } else {
    errors.push(`unknown kind: ${String((event as { kind?: unknown }).kind)}`);
  }
  return errors;
}
