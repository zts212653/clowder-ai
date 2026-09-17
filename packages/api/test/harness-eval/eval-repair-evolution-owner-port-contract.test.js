import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEvalRepairEvolutionOwnerPort } from '../../dist/infrastructure/harness-eval/eval-repair-evolution-owner-port.js';
import { actionRef, fixture, principal, ref } from './eval-repair-approval-fixtures.js';

const request = {
  programRef: ref('F311', 'program:closed-request-contract'),
  cycleRef: ref('F311', 'cycle:closed-request-contract:1'),
  interventionRef: ref('F311', 'intervention:closed-request-contract:1'),
  clientMessageId: 'closed-request-contract-1',
  requestAuthority: principal,
};

function portReturning(approvalResult) {
  const approval = fixture();
  const created = createEvalRepairEvolutionOwnerPort({
    contractVersion: 1,
    eventLog: approval.eventLog,
    approvalService: {
      async propose() {
        return approvalResult;
      },
    },
    requestAuthorityVerifier: {
      async verify() {
        return { status: 'verified', principal };
      },
    },
    lineageResolver: {
      async resolve() {
        return { status: 'resolved', caseActionRef: actionRef };
      },
    },
    valueDecisionAuthorityVerifier: {
      async verify() {
        throw new Error('requestApproval must not verify value-decision authority');
      },
    },
    decisionOwner: {
      async execute() {
        throw new Error('requestApproval must not execute a value decision');
      },
    },
  });
  assert.equal(created.status, 'active');
  return { approval, port: created.port };
}

describe('F313 Phase D requestApproval consumer contract', () => {
  it('maps every non-published approval result to an append-free typed blocker', async () => {
    for (const [approvalResult, expectedReason] of [
      [{ status: 'not_required', disposition: 'no_repair' }, 'approval_not_actionable'],
      [
        { status: 'superseded', freshCaseActionRef: 'case-action:fresh:2', drift: 'target' },
        'approval_superseded_before_publication',
      ],
    ]) {
      const { approval, port } = portReturning(approvalResult);

      const result = await port.requestApproval(request);

      assert.deepEqual(result, { status: 'blocked', reason: expectedReason });
      assert.ok(result.status === 'pending' || result.status === 'blocked');
      assert.deepEqual(approval.counts(), {
        proposals: 0,
        cards: 0,
        tasks: 0,
        leases: 0,
        mutations: 0,
      });
    }
  });
});
