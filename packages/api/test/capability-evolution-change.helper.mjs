import assert from 'node:assert/strict';
import {
  base,
  candidate,
  measurementRefs,
  observingProgram,
  owner,
} from './capability-evolution-evaluation.helper.mjs';

export { base, candidate, measurementRefs, observingProgram, owner };

export const exactTarget = (version = 'v1') => ({
  ownerFeatureId: 'F202',
  ownerStateRef: 'skill:investor-roadshow-expression',
  version,
  assetKind: 'skill',
  assetId: 'investor-roadshow-expression',
});

export const refs = {
  caseRef: owner('F266', 'eval-repair-case:case-1'),
  proposalRef: owner('F266', 'eval-repair-proposal:proposal-1'),
  ownerAuthorizationRef: owner('F202', 'execution-permission:investor-roadshow-expression-v1'),
  targetVersionRef: exactTarget(),
};

export const requestAuthority = {
  invocationId: 'invocation-phase4',
  userId: 'operator',
  catId: 'codex-sol',
  threadId: 'thread-phase4',
  originMessageId: 'message-phase4',
};

export const decisionAuthority = {
  kind: 'owner_session',
  userId: 'operator',
};

export function changeOwner(initial = { status: 'pending', ...refs }) {
  const state = {
    snapshot: initial,
    requestResult: { status: 'pending', ...refs },
    requestCalls: 0,
    resolveCalls: 0,
    decisionCalls: [],
  };
  return {
    state,
    async requestApproval(input) {
      state.requestCalls += 1;
      assert.deepEqual(Object.keys(input).sort(), [
        'clientMessageId',
        'cycleRef',
        'interventionRef',
        'programRef',
        'requestAuthority',
      ]);
      assert.deepEqual(input.requestAuthority, requestAuthority);
      return state.requestResult;
    },
    async resolveChange() {
      state.resolveCalls += 1;
      return state.snapshot;
    },
    async recordMetabolismDecision(input) {
      state.decisionCalls.push(input);
      if (input.decision === 'rollback') {
        return {
          status: 'recorded',
          decisionRef: owner('F266', `eval-repair-decision:${input.decision}`),
          executionReceiptRef: owner('F202', 'rollback-receipt:r1'),
          assetVersionRef: exactTarget('v0'),
        };
      }
      if (input.decision === 'sunset') {
        return {
          status: 'recorded',
          decisionRef: owner('F266', `eval-repair-decision:${input.decision}`),
          executionReceiptRef: owner('F202', 'sunset-receipt:s1'),
        };
      }
      if (input.decision === 'no_change') {
        return {
          status: 'recorded',
          decisionRef: owner('F266', 'eval-repair-decision:no_change'),
          executionReceiptRef: owner('F202', 'no-change-receipt:n1'),
          assetVersionRef: exactTarget('v2'),
        };
      }
      return { status: 'recorded', decisionRef: owner('F266', `eval-repair-decision:${input.decision}`) };
    },
  };
}

export async function awaitingApproval(ownerPort) {
  const fixture = await observingProgram({ changeOwner: ownerPort });
  const { service, programId } = fixture;
  await service.linkMeasurement({ ...base(programId, 4, 'measure'), ...measurementRefs() });
  await service.linkAttribution({
    ...base(programId, 5, 'attribute'),
    ...measurementRefs(),
    candidates: [candidate('execution')],
  });
  const gated = await service.linkIntervention({
    ...base(programId, 6, 'gate'),
    ownerUserId: 'operator',
    autoRecheckRef: owner('F192', 'eval-trigger:program'),
  });
  assert.equal(gated.projection.program.stage, 'awaiting_approval');
  return fixture;
}

export async function proposed(ownerPort) {
  const fixture = await awaitingApproval(ownerPort);
  const result = await fixture.service.proposeChange({
    ...base(fixture.programId, 7, 'propose-change'),
    requestAuthority,
  });
  assert.equal(result.outcome, 'appended');
  assert.equal(result.projection.program.stage, 'awaiting_approval');
  assert.equal(ownerPort.state.requestCalls, 1);
  return fixture;
}

export async function approved(ownerPort) {
  const fixture = await proposed(ownerPort);
  ownerPort.state.snapshot = {
    status: 'approved',
    ...refs,
    approvalRef: owner('F246', 'approval:proposal-1'),
  };
  const result = await fixture.service.syncChange(base(fixture.programId, 8, 'sync-approved'));
  assert.equal(result.projection.program.stage, 'writing_back');
  return fixture;
}

export async function deciding(ownerPort) {
  const fixture = await approved(ownerPort);
  ownerPort.state.snapshot = {
    status: 'mutated',
    ...refs,
    approvalRef: owner('F246', 'approval:proposal-1'),
    interventionReceiptRef: owner('F202', 'mutation-receipt:m1'),
    assetVersionRef: exactTarget('v2'),
    loadedRuntimeRef: owner('F302', 'loaded-runtime:alpha-v2'),
    changedAt: '2026-09-01T10:00:00.000Z',
    loadedAt: '2026-09-01T10:05:00.000Z',
  };
  const mutated = await fixture.service.syncChange(base(fixture.programId, 9, 'sync-mutation'));
  assert.equal(mutated.projection.program.stage, 'revalidating');

  ownerPort.state.snapshot = {
    status: 'outcome',
    ...refs,
    approvalRef: owner('F246', 'approval:proposal-1'),
    interventionReceiptRef: owner('F202', 'mutation-receipt:m1'),
    assetVersionRef: exactTarget('v2'),
    outcomeReceiptRef: owner('F266', 'eval-repair-outcome:o1'),
    loadedRuntimeRef: owner('F302', 'loaded-runtime:alpha-v2'),
    freshnessProofRef: owner('F267', 'measurement-proof:post-load-o1'),
    changedAt: '2026-09-01T10:00:00.000Z',
    loadedAt: '2026-09-01T10:05:00.000Z',
    measuredAt: '2026-09-01T11:00:00.000Z',
  };
  const outcome = await fixture.service.syncChange(base(fixture.programId, 10, 'sync-outcome'));
  assert.equal(outcome.projection.program.stage, 'deciding');
  return fixture;
}

export async function noChangeDeciding(ownerPort) {
  const fixture = await approved(ownerPort);
  ownerPort.state.snapshot = {
    status: 'outcome',
    ...refs,
    approvalRef: owner('F246', 'approval:proposal-1'),
    interventionReceiptRef: owner('F202', 'no-change-intervention-receipt:n1'),
    outcomeReceiptRef: owner('F266', 'eval-repair-outcome:no-change-1'),
    freshnessProofRef: owner('F267', 'measurement-proof:post-no-change-1'),
    recordedAt: '2026-09-01T10:00:00.000Z',
    measuredAt: '2026-09-01T11:00:00.000Z',
  };
  const intervened = await fixture.service.syncChange(base(fixture.programId, 9, 'sync-no-change-intervention'));
  assert.equal(intervened.projection.program.stage, 'revalidating');
  assert.equal(intervened.projection.lineage.current.status, 'no_change');
  const outcome = await fixture.service.syncChange(base(fixture.programId, 10, 'sync-no-change-outcome'));
  assert.equal(outcome.projection.program.stage, 'deciding');
  return fixture;
}
