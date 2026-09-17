import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectEvalRepairApprovals } from '../../dist/infrastructure/harness-eval/eval-repair-approval-projection.js';
import {
  EvalRepairOutcomeService,
  evalRepairCaseRef,
  evalRepairProposalRef,
} from '../../dist/infrastructure/harness-eval/eval-repair-outcome.js';
import { projectEvalRepairOutcome } from '../../dist/infrastructure/harness-eval/eval-repair-outcome-projection.js';
import {
  actionRef,
  caseAction,
  caseId,
  fixture,
  ownerAuthorizationRef,
  ownerRef,
  principal,
  ref,
  targetVersionRef,
  verdictId,
} from './eval-repair-approval-fixtures.js';

const programRef = ref('F311', 'program:quality-loop-1');
const cycleRef = ref('F311', 'cycle:quality-loop-1:1');
const interventionRef = ref('F311', 'intervention:quality-loop-1:1');
const lineage = { programRef, cycleRef, interventionRef };
const mainCommitSha = 'c'.repeat(40);
const loadedRuntimeHead = 'd'.repeat(40);
const changeReceiptRef = ref('F188', 'change-receipt:evidence-reader:1');
const noChangeReceiptRef = ref('F188', 'no-change-receipt:evidence-reader:1');
const outcomeReceiptRef = ref('F192', 'fresh-outcome:evidence-reader:1');
const alternateChangeReceiptRef = ref('F188', 'change-receipt:evidence-reader:alternate');
const alternateOutcomeReceiptRef = ref('F192', 'fresh-outcome:evidence-reader:alternate');
const changedAt = '2026-09-02T00:20:00.000Z';
const loadedAt = '2026-09-02T00:21:00.000Z';

async function approvedContext(overrides = {}) {
  const approval = fixture(overrides.approval);
  const proposed = await approval.service.propose({
    caseActionRef: actionRef,
    clientMessageId: 'client-owner-port-1',
    principal,
    ownerLineage: lineage,
  });
  assert.equal(proposed.status, 'published');
  const accepted = await approval.service.decide({
    proposalId: proposed.proposalId,
    decision: 'accept',
    reasonCode: 'accepted_as_proposed',
    decidedByUserId: principal.userId,
  });
  assert.equal(accepted.status, 'accepted');
  if (overrides.materialize !== false) {
    const materialized = await approval.service.materialize(proposed.proposalId);
    assert.equal(materialized.status, 'materialized');
  }
  const record = projectEvalRepairApprovals(await approval.eventLog.read(caseId)).proposals[0];
  const bindings = {
    caseRef: evalRepairCaseRef(caseId, verdictId),
    proposalRef: evalRepairProposalRef(proposed.proposalId),
    approvalRef: record.approvalRef,
    ownerAuthorizationRef,
    targetVersionRef,
    interventionRef,
  };
  const contacts = { intervention: 0, outcome: 0 };
  const ownerReceipts = new Map();
  const outcomeReceipts = new Map();
  let currentOwner = overrides.currentOwner ?? {
    status: 'resolved',
    ownerRef,
    ownerAuthorizationRef,
    targetVersionRef,
    dispatchRef: ref('F188', 'dispatch:repair-owner:f188'),
  };
  const service = new EvalRepairOutcomeService({
    eventLog: approval.eventLog,
    resolveCaseAction: async (candidate) => (candidate === actionRef ? caseAction() : null),
    resolveOwnerChangeContract: async () => structuredClone(currentOwner),
    interventionReceiptOwner: {
      async resolve(receiptRef) {
        contacts.intervention += 1;
        await overrides.beforeInterventionReceiptResolve?.(receiptRef);
        return structuredClone(ownerReceipts.get(receiptRef.ownerStateRef) ?? null);
      },
    },
    freshOutcomeOwner: {
      async resolve(receiptRef) {
        contacts.outcome += 1;
        return structuredClone(outcomeReceipts.get(receiptRef.ownerStateRef) ?? null);
      },
    },
    releaseTruth: overrides.releaseTruth ?? {
      loadedRuntimeHead,
      verifyMainLanded(commitSha) {
        if (overrides.mainMissing) throw Object.assign(new Error('not on main'), { code: 'main_not_landed' });
        return { commitSha, evidenceRef: `git:origin/main@${mainCommitSha}:contains:${commitSha}` };
      },
      verifyLiveActive(commitSha) {
        if (overrides.liveMissing) throw Object.assign(new Error('not loaded'), { code: 'live_not_active' });
        return { commitSha, evidenceRef: `runtime:${loadedRuntimeHead}:contains:${commitSha}` };
      },
    },
    now: () => '2026-09-02T00:30:00.000Z',
  });
  return {
    approval,
    service,
    proposed,
    bindings,
    ownerReceipts,
    outcomeReceipts,
    contacts,
    setCurrentOwner(owner) {
      currentOwner = owner;
    },
  };
}

function changedReceipt(bindings, overrides = {}) {
  return {
    kind: 'changed',
    ...bindings,
    receiptRef: changeReceiptRef,
    assetVersionRef: {
      ownerFeatureId: 'F188',
      ownerStateRef: 'asset:F188:evidence-reader',
      assetKind: 'feature_component',
      assetId: 'F188:evidence-reader',
      version: 'asset-v2',
    },
    mainCommitSha,
    loadedRuntimeRef: ref('F188', `runtime:${loadedRuntimeHead}`, loadedRuntimeHead),
    changedAt,
    loadedAt,
    ...overrides,
  };
}

function noChangeReceipt(bindings, overrides = {}) {
  return {
    kind: 'no_change',
    ...bindings,
    receiptRef: noChangeReceiptRef,
    reasonCode: 'evidence_already_satisfied',
    withdrawalCondition: 'Reopen when the failing sample recurs',
    nextEvalAt: '2026-09-09T00:00:00.000Z',
    recordedAt: changedAt,
    ...overrides,
  };
}

function freshOutcomeReceipt(bindings, overrides = {}) {
  return {
    ...bindings,
    receiptRef: outcomeReceiptRef,
    interventionReceiptRef: changeReceiptRef,
    reevaluationRef: ref('F192', 'reevaluation:evidence-reader:post-load:1'),
    freshnessProofRef: ref('F192', 'freshness:evidence-reader:post-load:1'),
    outcome: 'effective_keep',
    loadedRuntimeRef: ref('F188', `runtime:${loadedRuntimeHead}`, loadedRuntimeHead),
    measuredAt: '2026-09-02T00:25:00.000Z',
    uncontaminated: true,
    ...overrides,
  };
}

describe('F313 Phase D owner-backed intervention receipts', () => {
  it('records changed only from an exact owner receipt with independently verified main and live truth', async () => {
    const ctx = await approvedContext();
    ctx.ownerReceipts.set(changeReceiptRef.ownerStateRef, changedReceipt(ctx.bindings));

    const first = await ctx.service.recordIntervention({ ...ctx.bindings, receiptRef: changeReceiptRef });
    const replay = await ctx.service.recordIntervention({ ...ctx.bindings, receiptRef: changeReceiptRef });
    ctx.ownerReceipts.set(
      alternateChangeReceiptRef.ownerStateRef,
      changedReceipt(ctx.bindings, { receiptRef: alternateChangeReceiptRef }),
    );
    const collision = await ctx.service.recordIntervention({
      ...ctx.bindings,
      receiptRef: alternateChangeReceiptRef,
    });

    assert.equal(first.status, 'recorded');
    assert.equal(first.kind, 'changed');
    assert.equal(replay.status, 'duplicate');
    assert.deepEqual(collision, { status: 'blocked', reason: 'idempotency_collision' });
    assert.equal(ctx.contacts.intervention, 1, 'exactly-once replay must use the immutable F266 event');
    const projection = projectEvalRepairOutcome(await ctx.approval.eventLog.read(caseId), ctx.proposed.proposalId);
    assert.equal(projection.intervention.kind, 'changed');
    assert.equal(projection.intervention.mainCommitSha, mainCommitSha);
    assert.equal(projection.intervention.loadedAt, loadedAt);
    assert.equal(
      (await ctx.approval.eventLog.read(caseId)).filter((event) => event.type === 'repair_intervention_changed').length,
      1,
    );
  });

  it('rejects case/proposal/approval/target mismatches before contacting the asset owner', async () => {
    const ctx = await approvedContext();
    ctx.ownerReceipts.set(changeReceiptRef.ownerStateRef, changedReceipt(ctx.bindings));
    for (const forged of [
      { caseRef: ref('F266', 'eval-case:forged') },
      { proposalRef: ref('F266', 'eval-repair-proposal:forged') },
      { approvalRef: ref('F246', 'approval:F266:forged') },
      { targetVersionRef: { ...targetVersionRef, version: 'forged-version' } },
    ]) {
      const result = await ctx.service.recordIntervention({
        ...ctx.bindings,
        ...forged,
        receiptRef: changeReceiptRef,
      });
      assert.equal(result.status, 'blocked');
      assert.match(result.reason, /mismatch|not_found/);
    }
    assert.equal(ctx.contacts.intervention, 0);
    assert.equal(
      projectEvalRepairOutcome(await ctx.approval.eventLog.read(caseId), ctx.proposed.proposalId).intervention,
      undefined,
    );
  });

  it('supersedes stale authorization or target before owner contact and requires a fresh Approval', async () => {
    const staleTarget = { ...targetVersionRef, version: 'repair-target-v2' };
    const ctx = await approvedContext({
      currentOwner: {
        status: 'resolved',
        ownerRef,
        ownerAuthorizationRef: ref('F188', 'authorization:repair:f188:v2'),
        targetVersionRef: staleTarget,
        dispatchRef: ref('F188', 'dispatch:repair-owner:f188'),
      },
    });
    const result = await ctx.service.recordIntervention({ ...ctx.bindings, receiptRef: changeReceiptRef });

    assert.deepEqual(
      { status: result.status, reason: result.reason, drift: result.drift },
      { status: 'blocked', reason: 'approval_superseded', drift: 'authorization' },
    );
    assert.match(result.freshCaseActionRef, /^case-action:f266:/);
    assert.equal(ctx.contacts.intervention, 0);
    const record = projectEvalRepairApprovals(await ctx.approval.eventLog.read(caseId)).proposals[0];
    assert.equal(record.lifecycle.resolution, 'closed_without_decision');
  });

  it('rejects a receipt commit when the accepted Approval is superseded during owner resolution', async () => {
    let releaseReceipt;
    const receiptReleased = new Promise((resolve) => {
      releaseReceipt = resolve;
    });
    let markReceiptReached;
    const receiptReached = new Promise((resolve) => {
      markReceiptReached = resolve;
    });
    let pauseReceipt = true;
    const ctx = await approvedContext({
      async beforeInterventionReceiptResolve() {
        if (!pauseReceipt) return;
        pauseReceipt = false;
        markReceiptReached();
        await receiptReleased;
      },
    });
    ctx.ownerReceipts.set(changeReceiptRef.ownerStateRef, changedReceipt(ctx.bindings));

    const staleRequest = ctx.service.recordIntervention({ ...ctx.bindings, receiptRef: changeReceiptRef });
    await receiptReached;
    ctx.setCurrentOwner({
      status: 'resolved',
      ownerRef,
      ownerAuthorizationRef: ref('F188', 'authorization:repair:f188:v2'),
      targetVersionRef,
      dispatchRef: ref('F188', 'dispatch:repair-owner:f188'),
    });
    const supersedingRequest = await ctx.service.recordIntervention({
      ...ctx.bindings,
      receiptRef: changeReceiptRef,
    });
    releaseReceipt();
    const staleResult = await staleRequest;

    assert.equal(supersedingRequest.status, 'blocked');
    assert.equal(supersedingRequest.reason, 'approval_superseded');
    assert.deepEqual(staleResult, supersedingRequest);
    const events = await ctx.approval.eventLog.read(caseId);
    assert.equal(events.filter((event) => event.type === 'approval_superseded').length, 1);
    assert.equal(events.filter((event) => event.type === 'repair_intervention_changed').length, 0);
  });

  it('fails closed when a changed receipt lacks verified main or live truth', async () => {
    for (const missing of ['mainMissing', 'liveMissing']) {
      const ctx = await approvedContext({ [missing]: true });
      ctx.ownerReceipts.set(changeReceiptRef.ownerStateRef, changedReceipt(ctx.bindings));
      const result = await ctx.service.recordIntervention({ ...ctx.bindings, receiptRef: changeReceiptRef });
      assert.equal(result.status, 'blocked');
      assert.equal(result.reason, missing === 'mainMissing' ? 'main_not_landed' : 'live_not_active');
      assert.equal(
        projectEvalRepairOutcome(await ctx.approval.eventLog.read(caseId), ctx.proposed.proposalId).intervention,
        undefined,
      );
    }
  });

  it('records an explicit owner no-change receipt and rejects a missing receipt without an event', async () => {
    const missing = await approvedContext();
    const blocked = await missing.service.recordIntervention({
      ...missing.bindings,
      receiptRef: noChangeReceiptRef,
    });
    assert.deepEqual(blocked, { status: 'blocked', reason: 'owner_receipt_not_found' });
    assert.equal(
      projectEvalRepairOutcome(await missing.approval.eventLog.read(caseId), missing.proposed.proposalId).intervention,
      undefined,
    );

    const ctx = await approvedContext();
    ctx.ownerReceipts.set(noChangeReceiptRef.ownerStateRef, noChangeReceipt(ctx.bindings));
    const recorded = await ctx.service.recordIntervention({ ...ctx.bindings, receiptRef: noChangeReceiptRef });
    assert.equal(recorded.status, 'recorded');
    assert.equal(recorded.kind, 'no_change');
    const projection = projectEvalRepairOutcome(await ctx.approval.eventLog.read(caseId), ctx.proposed.proposalId);
    assert.equal(projection.intervention.reasonCode, 'evidence_already_satisfied');
    assert.equal(projection.intervention.nextEvalAt, '2026-09-09T00:00:00.000Z');
  });
});

describe('F313 Phase D fresh typed outcomes', () => {
  it('records only post-decision, post-load, uncontaminated evidence on the same lineage', async () => {
    const ctx = await approvedContext();
    ctx.ownerReceipts.set(changeReceiptRef.ownerStateRef, changedReceipt(ctx.bindings));
    await ctx.service.recordIntervention({ ...ctx.bindings, receiptRef: changeReceiptRef });
    ctx.outcomeReceipts.set(outcomeReceiptRef.ownerStateRef, freshOutcomeReceipt(ctx.bindings));

    const first = await ctx.service.recordOutcome({
      ...ctx.bindings,
      interventionReceiptRef: changeReceiptRef,
      outcomeReceiptRef,
    });
    const replay = await ctx.service.recordOutcome({
      ...ctx.bindings,
      interventionReceiptRef: changeReceiptRef,
      outcomeReceiptRef,
    });
    ctx.outcomeReceipts.set(
      alternateOutcomeReceiptRef.ownerStateRef,
      freshOutcomeReceipt(ctx.bindings, { receiptRef: alternateOutcomeReceiptRef }),
    );
    const collision = await ctx.service.recordOutcome({
      ...ctx.bindings,
      interventionReceiptRef: changeReceiptRef,
      outcomeReceiptRef: alternateOutcomeReceiptRef,
    });

    assert.deepEqual(first, { status: 'recorded', outcome: 'effective_keep' });
    assert.deepEqual(replay, { status: 'duplicate', outcome: 'effective_keep' });
    assert.deepEqual(collision, { status: 'blocked', reason: 'idempotency_collision' });
    assert.equal(ctx.contacts.outcome, 1);
    const projection = projectEvalRepairOutcome(await ctx.approval.eventLog.read(caseId), ctx.proposed.proposalId);
    assert.equal(projection.outcome.outcome, 'effective_keep');
    assert.equal(projection.outcome.measuredAt, '2026-09-02T00:25:00.000Z');
  });

  it('rejects merge-only evidence before contacting the outcome owner', async () => {
    const ctx = await approvedContext();
    ctx.outcomeReceipts.set(outcomeReceiptRef.ownerStateRef, freshOutcomeReceipt(ctx.bindings));
    const result = await ctx.service.recordOutcome({
      ...ctx.bindings,
      interventionReceiptRef: changeReceiptRef,
      outcomeReceiptRef,
    });
    assert.deepEqual(result, { status: 'blocked', reason: 'intervention_receipt_missing' });
    assert.equal(ctx.contacts.outcome, 0);
  });

  it('rejects stale, pre-load, contaminated, and runtime-mismatched outcome receipts without an event', async () => {
    for (const [overrides, reason] of [
      [{ measuredAt: '2026-09-02T00:05:00.000Z' }, 'stale_outcome'],
      [{ measuredAt: '2026-09-02T00:20:30.000Z' }, 'preload_outcome'],
      [{ uncontaminated: false }, 'contaminated_outcome'],
      [{ loadedRuntimeRef: ref('F188', 'runtime:other', 'other-head') }, 'loaded_runtime_mismatch'],
    ]) {
      const ctx = await approvedContext();
      ctx.ownerReceipts.set(changeReceiptRef.ownerStateRef, changedReceipt(ctx.bindings));
      await ctx.service.recordIntervention({ ...ctx.bindings, receiptRef: changeReceiptRef });
      ctx.outcomeReceipts.set(outcomeReceiptRef.ownerStateRef, freshOutcomeReceipt(ctx.bindings, overrides));
      const result = await ctx.service.recordOutcome({
        ...ctx.bindings,
        interventionReceiptRef: changeReceiptRef,
        outcomeReceiptRef,
      });
      assert.deepEqual(result, { status: 'blocked', reason });
      assert.equal(
        (await ctx.approval.eventLog.read(caseId)).filter((event) => event.type === 'repair_outcome_recorded').length,
        0,
      );
    }
  });

  it('accepts a fresh no-change re-evaluation only when it cites the owner no-change receipt', async () => {
    const ctx = await approvedContext();
    ctx.ownerReceipts.set(noChangeReceiptRef.ownerStateRef, noChangeReceipt(ctx.bindings));
    await ctx.service.recordIntervention({ ...ctx.bindings, receiptRef: noChangeReceiptRef });
    ctx.outcomeReceipts.set(
      outcomeReceiptRef.ownerStateRef,
      freshOutcomeReceipt(ctx.bindings, {
        interventionReceiptRef: noChangeReceiptRef,
        outcome: 'insufficient_observe',
        loadedRuntimeRef: undefined,
        measuredAt: '2026-09-02T00:25:00.000Z',
      }),
    );
    const result = await ctx.service.recordOutcome({
      ...ctx.bindings,
      interventionReceiptRef: noChangeReceiptRef,
      outcomeReceiptRef,
    });
    assert.deepEqual(result, { status: 'recorded', outcome: 'insufficient_observe' });
  });
});
