import type {
  AttributionDiagnosisV1,
  EvolutionGateBlockerV1,
  EvolutionProgramEventEnvelopeV1,
  OwnerTruthRefV1,
} from '@cat-cafe/shared';
import {
  type EvolutionAttributionExplanationV1,
  projectAttributionExplanation,
  projectInsufficientMeasurementExplanation,
} from './attribution-explanation.js';

/**
 * F311 Phase 3 — the read path for AC-34.
 *
 * The Workbench must be able to answer "what did we learn, and why are we not changing anything"
 * after any restart, so this projection is rebuilt from the Program event stream alone: the durable
 * typed diagnosis plus the persisted gate blockers. Nothing is read from a cache or a second store.
 *
 * Staleness is the real hazard here. A diagnosis describes ONE evaluation of ONE Cycle, so it is
 * dropped the moment the Program starts a new round — a new `evaluation_triggered`, a fresh
 * `measurement_linked`, or a Cycle rotation. Showing last round's `attributed` next to this round's
 * `insufficient` would be a lie told by omission. Likewise the gate is `pending` until it is
 * actually evaluated: only a canonical `intervention_linked` may render as `ready`.
 */
export function projectEvolutionAttribution(
  events: readonly EvolutionProgramEventEnvelopeV1[],
): EvolutionAttributionExplanationV1 | null {
  let diagnosis: AttributionDiagnosisV1 | null = null;
  let gateBlockers: readonly EvolutionGateBlockerV1[] | undefined;
  let interventionLinked = false;
  let insufficientMeasurement: Extract<
    EvolutionProgramEventEnvelopeV1['event'],
    { type: 'measurement_linked' }
  > | null = null;

  const reset = () => {
    diagnosis = null;
    gateBlockers = undefined;
    interventionLinked = false;
    insufficientMeasurement = null;
  };

  for (const envelope of events) {
    const event = envelope.event;
    switch (event.type) {
      // A closed Cycle's conclusion stops describing "now".
      case 'decision_recorded':
      // A new round has begun; last round's conclusion is history, not current state.
      case 'evaluation_triggered':
        reset();
        break;
      case 'measurement_linked':
        // Even a valid new measurement supersedes the previous round's diagnosis.
        reset();
        // An owner-declared insufficient bundle is itself a result to show, not an empty state.
        insufficientMeasurement = event.validity === 'insufficient' ? event : null;
        break;
      case 'attribution_linked':
        diagnosis = event.diagnosis;
        gateBlockers = undefined;
        interventionLinked = false;
        break;
      case 'observe_or_insufficient_recorded':
        gateBlockers = event.gateBlockers;
        break;
      case 'intervention_linked':
        interventionLinked = true;
        gateBlockers = [];
        break;
      default:
        break;
    }
  }

  if (diagnosis === null) {
    return insufficientMeasurement === null ? null : projectInsufficientMeasurementExplanation(insufficientMeasurement);
  }
  return projectAttributionExplanation({ diagnosis, gateBlockers, interventionLinked });
}
