import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectEvalRepairApprovals } from '../../dist/infrastructure/harness-eval/eval-repair-approval-projection.js';
import { createEvalRepairEvolutionOwnerPort } from '../../dist/infrastructure/harness-eval/eval-repair-evolution-owner-port.js';
import { evalRepairCaseRef } from '../../dist/infrastructure/harness-eval/eval-repair-outcome.js';
import {
  actionRef,
  caseId,
  fixture,
  ownerAuthorizationRef,
  principal,
  ref,
  targetVersionRef,
} from './eval-repair-approval-fixtures.js';

const programRef = ref('F311', 'program:quality-loop-port');
const cycleRef = ref('F311', 'cycle:quality-loop-port:1');
const interventionRef = ref('F311', 'intervention:quality-loop-port:1');
const outcomeReceiptRef = ref('F192', 'fresh-outcome:quality-loop-port:1');
const ownerSessionRef = ref('F313', 'owner-session:operator:exact');

function completeOptions(overrides = {}) {
  const approval = overrides.approval ?? fixture();
  const calls = overrides.calls ?? { authority: 0, lineage: 0, decisionAuthority: 0, decisionOwner: 0 };
  return {
    approval,
    calls,
    options: {
      contractVersion: 1,
      eventLog: approval.eventLog,
      approvalService: approval.service,
      requestAuthorityVerifier: {
        async verify(candidate) {
          calls.authority += 1;
          return candidate.invocationId === principal.invocationId &&
            candidate.threadId === principal.threadId &&
            candidate.originMessageId === principal.originMessageId
            ? { status: 'verified', principal }
            : { status: 'blocked', reason: 'request_origin_unverified' };
        },
      },
      lineageResolver: {
        async resolve(input) {
          calls.lineage += 1;
          if (overrides.lineageResult) return structuredClone(overrides.lineageResult);
          return input.programRef.ownerStateRef === programRef.ownerStateRef &&
            input.cycleRef.ownerStateRef === cycleRef.ownerStateRef &&
            input.interventionRef.ownerStateRef === interventionRef.ownerStateRef
            ? { status: 'resolved', caseActionRef: actionRef }
            : { status: 'blocked', reason: 'lineage_mismatch' };
        },
      },
      valueDecisionAuthorityVerifier: {
        async verify(authority) {
          calls.decisionAuthority += 1;
          if (authority.kind === 'owner_session' && authority.userId === principal.userId) {
            return { status: 'verified', authorityRef: ownerSessionRef };
          }
          return authority.kind === 'owner_source' &&
            authority.invocationId === principal.invocationId &&
            authority.threadId === principal.threadId &&
            authority.originMessageId === principal.originMessageId
            ? {
                status: 'verified',
                authorityRef: ref('F313', `owner-source:${authority.originMessageId}`),
              }
            : { status: 'blocked', reason: 'value_authority_unverified' };
        },
      },
      decisionOwner: {
        async execute(input) {
          calls.decisionOwner += 1;
          return {
            status: 'recorded',
            decisionRef: ref('F311', `decision:${input.clientMessageId}`),
            executionReceiptRef: ref('F311', `decision-receipt:${input.clientMessageId}`),
          };
        },
      },
      now: () => '2026-09-02T01:00:00.000Z',
    },
  };
}

const request = {
  programRef,
  cycleRef,
  interventionRef,
  clientMessageId: 'owner-port-request-1',
  requestAuthority: principal,
};

describe('F313 Phase D F311 ref-only owner port', () => {
  it('keeps the production adapter dormant with zero effects when any binding is missing', async () => {
    const { options, calls } = completeOptions();
    for (const missing of [
      'eventLog',
      'approvalService',
      'requestAuthorityVerifier',
      'lineageResolver',
      'valueDecisionAuthorityVerifier',
      'decisionOwner',
    ]) {
      const candidate = { ...options, [missing]: undefined };
      const result = createEvalRepairEvolutionOwnerPort(candidate);
      assert.equal(result.status, 'blocked');
      assert.ok(result.missing.includes(missing));
      assert.deepEqual(result.effects, {
        approvalProposal: false,
        approvalCard: false,
        ownerContact: false,
        mutation: false,
        outcome: false,
        decisionEvent: false,
      });
    }
    assert.deepEqual(calls, { authority: 0, lineage: 0, decisionAuthority: 0, decisionOwner: 0 });
  });

  it('resolves canonical caseActionRef from owner lineage and never derives it from target/user strings', async () => {
    const ctx = completeOptions();
    const active = createEvalRepairEvolutionOwnerPort(ctx.options);
    assert.equal(active.status, 'active');
    const result = await active.port.requestApproval(request);
    assert.equal(result.status, 'pending');
    assert.deepEqual(result.caseRef, evalRepairCaseRef(caseId, 'f313-friction-finding-1'));
    assert.deepEqual(result.ownerAuthorizationRef, ownerAuthorizationRef);
    assert.deepEqual(result.targetVersionRef, targetVersionRef);
    const approvalRecord = projectEvalRepairApprovals(await ctx.approval.eventLog.read(caseId)).proposals[0];
    assert.deepEqual(approvalRecord.proposal.ownerLineage, { programRef, cycleRef, interventionRef });
  });

  it('blocks forged origin and ambiguous lineage before proposal/card/event side effects', async () => {
    const forged = completeOptions();
    const forgedPort = createEvalRepairEvolutionOwnerPort(forged.options).port;
    const rejected = await forgedPort.requestApproval({
      ...request,
      requestAuthority: { ...principal, originMessageId: 'forged-message' },
    });
    assert.deepEqual(rejected, { status: 'blocked', reason: 'request_origin_unverified' });
    assert.equal(forged.calls.lineage, 0);
    assert.deepEqual(forged.approval.counts(), {
      proposals: 0,
      cards: 0,
      tasks: 0,
      leases: 0,
      mutations: 0,
    });

    const ambiguous = completeOptions({
      lineageResult: { status: 'blocked', reason: 'lineage_ambiguous' },
    });
    const ambiguousPort = createEvalRepairEvolutionOwnerPort(ambiguous.options).port;
    const blocked = await ambiguousPort.requestApproval(request);
    assert.deepEqual(blocked, { status: 'blocked', reason: 'lineage_ambiguous' });
    assert.deepEqual(ambiguous.approval.counts(), {
      proposals: 0,
      cards: 0,
      tasks: 0,
      leases: 0,
      mutations: 0,
    });
  });

  it('returns only owner refs/status/times and no copied Approval or intervention payload', async () => {
    const ctx = completeOptions();
    const port = createEvalRepairEvolutionOwnerPort(ctx.options).port;
    const pending = await port.requestApproval(request);
    const snapshot = await port.resolveChange({ caseRef: pending.caseRef, proposalRef: pending.proposalRef });
    assert.equal(snapshot.status, 'pending');
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      'expectedChange',
      'costAndRollback',
      'withdrawalCondition',
      'reasonCode',
      'requestOrigin',
      'dispatchSnapshot',
      'findingArtifactRef',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `must not copy ${forbidden}`);
    }
  });

  it('surfaces an owner no-change receipt as ref-only status and time', async () => {
    const ctx = completeOptions();
    const port = createEvalRepairEvolutionOwnerPort(ctx.options).port;
    const pending = await port.requestApproval(request);
    const proposalId = pending.proposalRef.ownerStateRef.replace('eval-repair-proposal:', '');
    await ctx.approval.service.decide({
      proposalId,
      decision: 'accept',
      reasonCode: 'accepted_as_proposed',
      decidedByUserId: principal.userId,
    });
    await ctx.approval.service.materialize(proposalId);
    const record = projectEvalRepairApprovals(await ctx.approval.eventLog.read(caseId)).proposals[0];
    const events = await ctx.approval.eventLog.read(caseId);
    await ctx.approval.eventLog.append(
      {
        eventId: `f266:${caseId}:intervention:${proposalId}`,
        caseId,
        verdictId: record.proposal.verdictId,
        domainId: record.proposal.domainId,
        type: 'repair_intervention_no_change',
        actor: { kind: 'automation', id: 'test-owner' },
        occurredAt: '2026-09-02T00:40:00.000Z',
        reason: 'canonical owner no-change receipt',
        refs: [{ kind: 'other', availability: 'available', value: 'no-change-receipt:test' }],
        proposalId,
        caseActionRef: actionRef,
        approvalRef: record.approvalRef,
        requestSnapshot: record.proposal.requestSnapshot,
        ownerLineage: { programRef, cycleRef, interventionRef },
        interventionReceiptRef: ref('F188', 'no-change-receipt:test'),
        reasonCode: 'evidence_already_satisfied',
        withdrawalCondition: 'reopen on recurrence',
        nextEvalAt: '2026-09-09T00:00:00.000Z',
        recordedAt: '2026-09-02T00:39:00.000Z',
      },
      events.length,
    );
    const snapshot = await port.resolveChange({ caseRef: pending.caseRef, proposalRef: pending.proposalRef });
    assert.equal(snapshot.status, 'no_change');
    assert.equal(snapshot.recordedAt, '2026-09-02T00:39:00.000Z');
    assert.equal(snapshot.interventionReceiptRef.ownerStateRef, 'no-change-receipt:test');
    assert.equal(JSON.stringify(snapshot).includes('withdrawalCondition'), false);

    const outcomeEvents = await ctx.approval.eventLog.read(caseId);
    await ctx.approval.eventLog.append(
      {
        eventId: `f266:${caseId}:outcome:${proposalId}`,
        caseId,
        verdictId: record.proposal.verdictId,
        domainId: record.proposal.domainId,
        type: 'repair_outcome_recorded',
        actor: { kind: 'automation', id: 'test-outcome-owner' },
        occurredAt: '2026-09-02T00:50:00.000Z',
        reason: 'fresh no-change outcome',
        refs: [{ kind: 'reeval', availability: 'available', value: 'reeval:no-change:1' }],
        proposalId,
        caseActionRef: actionRef,
        approvalRef: record.approvalRef,
        requestSnapshot: record.proposal.requestSnapshot,
        ownerLineage: { programRef, cycleRef, interventionRef },
        interventionReceiptRef: snapshot.interventionReceiptRef,
        outcomeReceiptRef: ref('F192', 'outcome:no-change:1'),
        reevaluationRef: ref('F192', 'reeval:no-change:1'),
        freshnessProofRef: ref('F192', 'freshness:no-change:1'),
        outcome: 'insufficient_observe',
        measuredAt: '2026-09-02T00:49:00.000Z',
      },
      outcomeEvents.length,
    );
    const outcome = await port.resolveChange({ caseRef: pending.caseRef, proposalRef: pending.proposalRef });
    assert.equal(outcome.status, 'outcome');
    assert.equal(outcome.recordedAt, '2026-09-02T00:39:00.000Z');
    assert.equal(outcome.loadedRuntimeRef, undefined);
  });

  it('requires direct owner or exact owner-source authority; agent-key cannot sign a value decision', async () => {
    const ctx = completeOptions();
    const port = createEvalRepairEvolutionOwnerPort(ctx.options).port;
    const requested = await port.requestApproval(request);
    await ctx.approval.service.decide({
      proposalId: requested.proposalRef.ownerStateRef.replace('eval-repair-proposal:', ''),
      decision: 'accept',
      reasonCode: 'accepted_as_proposed',
      decidedByUserId: principal.userId,
    });
    const proposalId = requested.proposalRef.ownerStateRef.replace('eval-repair-proposal:', '');
    const approvalRecord = projectEvalRepairApprovals(await ctx.approval.eventLog.read(caseId)).proposals[0];
    const events = await ctx.approval.eventLog.read(caseId);
    await ctx.approval.eventLog.append(
      {
        eventId: 'f266:test:outcome:owner-port',
        caseId,
        verdictId: approvalRecord.proposal.verdictId,
        domainId: approvalRecord.proposal.domainId,
        type: 'repair_outcome_recorded',
        actor: { kind: 'automation', id: 'test-owner' },
        occurredAt: '2026-09-02T00:50:00.000Z',
        reason: 'fresh test outcome',
        refs: [{ kind: 'reeval', availability: 'available', value: 'reeval:test:1' }],
        proposalId,
        caseActionRef: actionRef,
        approvalRef: approvalRecord.approvalRef,
        requestSnapshot: approvalRecord.proposal.requestSnapshot,
        ownerLineage: { programRef, cycleRef, interventionRef },
        interventionReceiptRef: ref('F188', 'change-receipt:test:1'),
        outcomeReceiptRef,
        reevaluationRef: ref('F192', 'reeval:test:1'),
        freshnessProofRef: ref('F192', 'freshness:test:1'),
        outcome: 'effective_keep',
        loadedRuntimeRef: ref('F188', 'runtime:test:1'),
        measuredAt: '2026-09-02T00:49:00.000Z',
      },
      events.length,
    );
    const base = {
      programRef,
      cycleRef,
      caseRef: requested.caseRef,
      proposalRef: requested.proposalRef,
      outcomeReceiptRef,
      decision: 'keep',
      clientMessageId: 'decision-1',
    };
    const rejected = await port.recordMetabolismDecision({
      ...base,
      decisionAuthority: { kind: 'agent_key', catId: 'codex-sol' },
    });
    assert.deepEqual(rejected, { status: 'blocked', reason: 'value_authority_unverified' });
    assert.equal(ctx.calls.decisionOwner, 0);

    const recorded = await port.recordMetabolismDecision({
      ...base,
      decisionAuthority: { kind: 'owner_session', userId: principal.userId },
    });
    const authority = { kind: 'owner_source', ...principal };
    const replay = await port.recordMetabolismDecision({ ...base, decisionAuthority: authority });
    const collision = await port.recordMetabolismDecision({
      ...base,
      decision: 'rollback',
      clientMessageId: 'decision-2',
      decisionAuthority: authority,
    });
    assert.equal(recorded.status, 'recorded');
    assert.equal(replay.status, 'duplicate');
    assert.deepEqual(collision, { status: 'blocked', reason: 'idempotency_collision' });
    assert.equal(ctx.calls.decisionOwner, 1);
    assert.equal(
      (await ctx.approval.eventLog.read(caseId)).filter((event) => event.type === 'repair_metabolism_decided').length,
      1,
    );
  });
});
