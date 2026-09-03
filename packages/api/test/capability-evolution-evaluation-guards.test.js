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
 * F311 Phase 3 ingress guards.
 *
 * Split from the happy-path file so the negative contract is readable on its own: these are the
 * assertions that say what the ingress must REFUSE — a missing owner contract, an unavailable
 * owner, a retry that must stay idempotent, evidence this Program never connected, and an
 * attribution that does not belong to the measurement the Cycle landed on.
 */

/** Drives a Program through a full round so the owner's ruler has actually moved (v3 -> v4). */
async function twoRoundProgram() {
  // The gate must BLOCK for the Cycle to return to observing and a second round to open. An
  // owner card missing a falsifier is the honest way to get there — a complete card would open
  // Change Review, which is a different (and terminal-for-this-round) path.
  const fixture = await observingProgram({
    bundle: { interventionCard: completeCard({ interventionFalsifierRef: undefined }) },
  });
  const { service, programId } = fixture;
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
  return fixture;
}

describe('F311 Phase 3 evaluation ingress guards', () => {
  it('will not even open a round without the F267 owner contract', async () => {
    // Reaching `evaluating` at all now requires the owner, so "the contract is not wired" can no
    // longer be a condition that only bites at measurement time — it stops the round from opening.
    const { service, programId } = await observingProgram({ stopBeforeTrigger: true, ownerContract: 'absent' });
    await assert.rejects(
      service.triggerEvaluation({
        ...base(programId, 3, 'triggered'),
        ownerUserId: 'operator',
        evidenceProofRef: owner('F267', 'measurement-proof:proof-1'),
      }),
      /owner contract is not available/,
    );
  });

  it('will not open a round F192 did not dispatch', async () => {
    // A caller must not be able to start a round on demand: that would reset the Cycle and discard
    // the diagnosis the previous round landed.
    const { service, programId } = await observingProgram({
      stopBeforeTrigger: true,
      roundDispatch: { outcome: 'suppressed_by_window', dedupeKey: 'round-1' },
    });
    await assert.rejects(
      service.triggerEvaluation({
        ...base(programId, 3, 'triggered'),
        ownerUserId: 'operator',
        evidenceProofRef: owner('F267', 'measurement-proof:proof-1'),
      }),
      /F192 did not open a round/,
    );
  });

  it('fails closed when the owner cannot produce the measurement evidence', async () => {
    const { service, programId } = await observingProgram({
      evaluationOwnerResolver: { resolveMeasurement: async () => ({ status: 'unavailable', reason: 'no proof' }) },
    });
    await assert.rejects(
      service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() }),
      /owner measurement evidence unavailable/,
    );
  });

  it('treats a retry of the same request as duplicate, not conflict', async () => {
    const { service, programId } = await observingProgram();
    const first = await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    assert.equal(first.outcome, 'appended');
    const retry = await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    assert.equal(retry.outcome, 'duplicate');
  });

  it('does not let a reused clientMessageId hide different content', async () => {
    const { service, programId } = await observingProgram();
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    // Same id, different subject: that is a collision, not a retry.
    await assert.rejects(
      service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs('proof-2') }),
      /event identity was reused for different content/,
    );
  });

  it('does not let a reused clientMessageId hide a different attribution', async () => {
    // The earlier idempotency preflight only compared `measurement_linked` refs, so a second
    // attribution under the same id was answered `duplicate` and silently dropped — the Program
    // reported success while the caller's actual diagnosis was never recorded.
    const { service, programId } = await observingProgram();
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    const attribution = {
      ...base(programId, 5, 'attribute'),
      ...measurementRefs(),
      candidates: [candidate('execution')],
    };
    const first = await service.linkAttribution(attribution);
    assert.equal(first.outcome, 'appended');
    // Byte-identical retry is still a duplicate.
    assert.equal((await service.linkAttribution(attribution)).outcome, 'duplicate');
    await assert.rejects(
      service.linkAttribution({ ...attribution, candidates: [candidate('harness')] }),
      /event identity was reused for different content/,
    );
  });

  it('raises a collision when two different commands derive the same event', async () => {
    // The preflight digest is not enough on its own. Two requests can differ and still derive an
    // identical event — here the second lists the same evidence twice, which the diagnosis dedupes —
    // and the append path decides `duplicate` from the EVENT. Without the command in that identity
    // the second command was silently discarded while the caller was told "already applied".
    const { service, programId } = await observingProgram();
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    const attribution = {
      ...base(programId, 5, 'attribute'),
      ...measurementRefs(),
      candidates: [candidate('execution')],
    };
    assert.equal((await service.linkAttribution(attribution)).outcome, 'appended');
    await assert.rejects(
      service.linkAttribution({
        ...attribution,
        candidates: [{ layer: 'execution', evidenceRefs: [TRAJECTORY, TRAJECTORY] }],
      }),
      /event identity was reused for different content/,
    );
  });

  it('persists the decision proof this round was read out of', async () => {
    // Without it the stream stops at the measurement result, and after a restart nothing says which
    // F267 proof authorised reading it.
    const { eventLog, service, programId } = await observingProgram();
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    const [measurement] = (await eventLog.read(programId)).slice(-1);
    assert.equal(
      measurement.event.evidenceRefs.some(
        (ref) => ref.ownerStateRef === measurementRefs().evidenceProofRef.ownerStateRef,
      ),
      true,
      'measurement_linked lineage must name the decision proof it consumed',
    );
  });

  it('refuses an attribution that does not reference the landed measurement', async () => {
    const { service, programId } = await observingProgram();
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    await assert.rejects(
      service.linkAttribution({
        ...base(programId, 5, 'attribute'),
        evidenceProofRef: owner('F267', 'measurement-proof:OTHER'),
        candidates: [candidate('execution')],
      }),
      /measurement result this Cycle landed on/,
    );
  });

  it('refuses a rejudge cell that was not scored on the axis it claims', async () => {
    // The counter-example this closes: four arbitrary refs labelled as a complete 2x2 used to be
    // enough to have the comparison declared `comparable, mode=baseline_rebuild, reasons=[]`. Every
    // cell now names a decision proof, and the Program checks the cell really sits where it claims.
    const { service, programId } = await twoRoundProgram();
    await assert.rejects(
      service.linkAttribution({
        ...base(programId, 9, 'attribute-2'),
        ...measurementRefs('proof-2'),
        candidates: [candidate('execution')],
        rejudge: {
          cells: [
            // Claims the `previous` axis, but the owner scored proof-2 with the CURRENT ruler.
            { rubric: 'previous', candidate: 'previous', evidenceProofRef: owner('F267', 'measurement-proof:proof-2') },
          ],
        },
      }),
      /was not scored with the previous rubric/,
    );
  });

  it('will not take a baseline rebuild the owner cannot resolve', async () => {
    const { service, programId } = await observingProgram();
    await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
    await assert.rejects(
      service.linkAttribution({
        ...base(programId, 5, 'attribute'),
        ...measurementRefs(),
        candidates: [candidate('execution')],
        // A ref a caller invented is not a rebuilt baseline; it is a decision proof or it is nothing.
        baselineRebuildProofRef: owner('F267', 'baseline-rebuild:invented'),
      }),
      /invalid_proof_ref/,
    );
  });

  it('keeps both rubric versions in the persisted evidence', async () => {
    // Full ref identity: v3 and v4 are two pieces of evidence, not one deduplicated entry. The two
    // versions come from two rounds the OWNER scored differently — neither request names a rubric.
    const { eventLog, service, programId } = await twoRoundProgram();
    await service.linkAttribution({
      ...base(programId, 9, 'attribute-2'),
      ...measurementRefs('proof-2'),
      candidates: [candidate('execution')],
    });
    const events = await eventLog.read(programId);
    const diagnosis = events.at(-1).event.diagnosis;
    const versions = diagnosis.evidenceRefs
      .filter((ref) => ref.assetKind === 'rubric')
      .map((ref) => ref.version)
      .sort();
    assert.deepEqual(versions, ['v3', 'v4']);
  });
});
