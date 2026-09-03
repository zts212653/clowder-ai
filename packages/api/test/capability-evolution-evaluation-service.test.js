import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  base,
  COHORT,
  candidate,
  completeCard,
  EYE,
  MemoryEventLog,
  measurementRefs,
  observingProgram,
  owner,
  ownerResolver,
  projectEvolutionAttribution,
  rubric,
  TRAJECTORY,
} from './capability-evolution-evaluation.helper.mjs';

/**
 * F311 Phase 3 production ingress: can a Program actually reach these states on the real
 * EvolutionProgramService event stream? No synthetic event fixture can answer that.
 */

describe('F311 Phase 3 evaluation ingress on the real Program stream', () => {
  it('drives a Program from evaluating through attribution to a blocked Change Review', async () => {
    // The owner publishes a card with one falsifier missing; the gate must refuse on that alone.
    const { eventLog, service, programId } = await observingProgram({
      bundle: { interventionCard: completeCard({ interventionFalsifierRef: undefined }) },
    });

    const measured = await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    assert.equal(measured.outcome, 'appended');
    assert.equal(measured.projection.program.stage, 'attributing');

    const attributed = await service.linkAttribution({
      ...base(programId, 5, 'attribute'),
      ...measurementRefs(),
      candidates: [candidate('execution'), candidate('harness')],
    });
    assert.equal(attributed.outcome, 'appended');
    assert.equal(attributed.projection.program.stage, 'awaiting_intervention');
    assert.equal(attributed.projection.attribution.verdict, 'attributed');
    // The gate has not run yet, so it must read pending — never ready.
    assert.equal(attributed.projection.attribution.gate.status, 'pending');

    const blocked = await service.linkIntervention({
      ...base(programId, 6, 'gate'),
      ownerUserId: 'operator',
      autoRecheckRef: owner('F192', 'eval-trigger:program'),
    });
    assert.equal(blocked.outcome, 'appended');
    // A blocked gate goes back to observing on the zero-approval lane, never to approval.
    assert.equal(blocked.projection.program.stage, 'observing');
    const explanation = blocked.projection.attribution;
    assert.equal(explanation.gate.status, 'blocked');
    assert.ok(explanation.gate.blockers.some((entry) => entry.code === 'intervention_falsifier_missing'));
    assert.ok(explanation.gate.blockers.every((entry) => typeof entry.ownerFeatureId === 'string'));

    const events = await eventLog.read(programId);
    const appended = events.at(-1).event;
    assert.equal(appended.type, 'observe_or_insufficient_recorded');
    assert.ok(appended.gateBlockers.length > 0);
  });

  it('opens Change Review only with a complete owner-held card', async () => {
    const { service, programId } = await observingProgram();
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    await service.linkAttribution({
      ...base(programId, 5, 'attribute'),
      ...measurementRefs(),
      candidates: [candidate('execution')],
    });
    const ready = await service.linkIntervention({
      ...base(programId, 6, 'gate'),
      ownerUserId: 'operator',
      autoRecheckRef: owner('F192', 'eval-trigger:program'),
    });
    assert.equal(ready.projection.program.stage, 'awaiting_approval');
    assert.equal(ready.projection.attribution.gate.status, 'ready');
    assert.deepEqual(ready.projection.attribution.whyNotChange, []);
  });

  it('keeps Change Review closed when the owner published no structured card', async () => {
    // The legacy F267 intervention card is free text end to end. It may describe a plan; it can
    // never open Change Review, because a paragraph is not a resolvable falsifier, holdout or
    // rollback. An owner that publishes nothing structured leaves the gate shut.
    const { service, programId } = await observingProgram({
      bundle: { interventionCard: undefined, gateReceiptRef: undefined },
    });
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    await service.linkAttribution({
      ...base(programId, 5, 'attribute'),
      ...measurementRefs(),
      candidates: [candidate('execution')],
    });
    const blocked = await service.linkIntervention({
      ...base(programId, 6, 'gate'),
      ownerUserId: 'operator',
      autoRecheckRef: owner('F192', 'eval-trigger:program'),
    });
    assert.equal(blocked.projection.program.stage, 'observing');
    assert.equal(blocked.projection.attribution.gate.status, 'blocked');
    assert.ok(blocked.projection.attribution.gate.blockers.length > 0);
  });

  it('routes an owner-declared insufficient bundle back to observing without an attribution', async () => {
    const { service, programId } = await observingProgram({ bundle: { ownerDecisionStatus: 'insufficient' } });
    const measured = await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    assert.equal(measured.projection.program.stage, 'observing');
    // An owner-declared insufficient bundle is a result, not an empty state.
    assert.equal(measured.projection.attribution.verdict, 'insufficient');
    assert.equal(measured.projection.attribution.gate.status, 'blocked');
  });

  it('records an incomparable verdict when the ruler moved without a rejudge', async () => {
    // The move is discovered, not declared: round one is scored with the owner's v3 rubric and round
    // two with v4, and the Program compares what it recorded last round against what the owner
    // reports this round. Nothing in either request mentions a rubric.
    //
    // Round one's gate must BLOCK for the Cycle to return to observing and round two to open; an
    // owner card missing a falsifier is the honest way there, since a complete card opens Change
    // Review instead.
    const { service, programId } = await observingProgram({
      bundle: { interventionCard: completeCard({ interventionFalsifierRef: undefined }) },
    });
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    await service.linkAttribution({
      ...base(programId, 5, 'attribute'),
      ...measurementRefs(),
      candidates: [candidate('execution')],
    });
    await service.linkIntervention({
      ...base(programId, 6, 'gate'),
      ownerUserId: 'operator',
      autoRecheckRef: owner('F192', 'eval-trigger:program'),
    });
    await service.triggerEvaluation({
      ...base(programId, 7, 'retrigger'),
      ownerUserId: 'operator',
      evidenceProofRef: owner('F267', 'measurement-proof:proof-2'),
    });
    await service.linkMeasurement({ ...base(programId, 8, 'measure-2'), ...measurementRefs('proof-2') });
    const attributed = await service.linkAttribution({
      ...base(programId, 9, 'attribute-2'),
      ...measurementRefs('proof-2'),
      candidates: [candidate('execution')],
    });
    const explanation = attributed.projection.attribution;
    assert.equal(explanation.verdict, 'incomparable');
    assert.equal(explanation.comparability.status, 'incomparable');
    assert.ok(!explanation.comparability.label.includes('跑满'));
    // Not actionable, so the Cycle goes to deciding rather than awaiting an intervention.
    assert.equal(attributed.projection.program.stage, 'deciding');
  });

  it('drops the previous round diagnosis when a new evaluation starts', async () => {
    const { eventLog, service, programId } = await observingProgram({
      bundle: { interventionCard: completeCard({ interventionFalsifierRef: undefined }) },
    });
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    await service.linkAttribution({
      ...base(programId, 5, 'attribute'),
      ...measurementRefs(),
      candidates: [candidate('execution')],
    });
    await service.linkIntervention({
      ...base(programId, 6, 'gate'),
      ownerUserId: 'operator',
      autoRecheckRef: owner('F192', 'eval-trigger:program'),
    });
    // Round two opens the same way round one did — through F192's dispatch, not by writing to the log.
    assert.equal(
      (
        await service.triggerEvaluation({
          ...base(programId, 7, 'retrigger'),
          ownerUserId: 'operator',
          evidenceProofRef: owner('F267', 'measurement-proof:proof-1'),
        })
      ).outcome,
      'appended',
    );

    const events = await eventLog.read(programId);
    // The stale `attributed` from round one must not describe round two.
    assert.equal(projectEvolutionAttribution(events), null);

    // A fresh usable measurement with no attribution yet: null is correct — there is no diagnosis.
    const remeasured = await service.linkMeasurement({ ...base(programId, 8, 'measure-2'), ...measurementRefs() });
    assert.equal(remeasured.projection.attribution, null);
  });

  it('refuses the gate when this Cycle has no durable attribution', async () => {
    const { service, programId } = await observingProgram();
    await assert.rejects(
      service.linkIntervention({
        ...base(programId, 4, 'gate'),
        ownerUserId: 'operator',
        autoRecheckRef: owner('F192', 'eval-trigger:program'),
      }),
      /durable attribution/,
    );
  });

  it('blocks a card whose owner-side evidence is self-certified by F311', async () => {
    const { service, programId } = await observingProgram({
      bundle: {
        interventionCard: completeCard({ interventionFalsifierRef: owner('F311', 'local-falsifier:self') }),
      },
    });
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    await service.linkAttribution({
      ...base(programId, 5, 'attribute'),
      ...measurementRefs(),
      candidates: [candidate('execution')],
    });
    const blocked = await service.linkIntervention({
      ...base(programId, 6, 'gate'),
      ownerUserId: 'operator',
      interventionLayerRef: owner('F202', 'intervention-layer:skill'),
      gateReceiptRef: owner('F267', 'intervention-gate-receipt:c1'),
      autoRecheckRef: owner('F192', 'eval-trigger:program'),
    });
    assert.equal(blocked.projection.attribution.gate.status, 'blocked');
    assert.ok(
      blocked.projection.attribution.gate.blockers.some((entry) => entry.code === 'gate_evidence_not_owner_held'),
    );
  });
});
