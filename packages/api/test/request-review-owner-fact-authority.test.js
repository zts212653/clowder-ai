import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RequestReviewOwnerFactAuthority } from '../dist/infrastructure/capability-evolution/change/request-review-owner-fact-authority.js';
import {
  actionRef,
  caseAction,
  fixture,
  principal,
  proposeAndAccept,
  ref,
} from './harness-eval/eval-repair-approval-fixtures.js';

const targetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};
const ownerLineage = {
  programRef: {
    ownerFeatureId: 'F311',
    ownerStateRef: 'evolution-program:ba0f4524e49cc879279164d5b272cf8c',
  },
  cycleRef: {
    ownerFeatureId: 'F311',
    ownerStateRef: 'evolution-cycle:evolution-program:ba0f4524e49cc879279164d5b272cf8c:1',
  },
  interventionRef: {
    ownerFeatureId: 'F100',
    ownerStateRef: 'capability:development-process-harness-effectiveness',
  },
};

describe('request-review owner-fact custody authority', () => {
  it('admits only the strict active invocation matching the materialized Task/F167 holder', async () => {
    const ownerSnapshot = {
      status: 'resolved',
      ownerRef: ref('F100', 'owner:request-review'),
      ownerAuthorizationRef: ref('F100', `authorization:request-review:${targetVersionRef.version}`),
      targetVersionRef,
      dispatchRef: ref('F100', `dispatch:request-review:${targetVersionRef.version}`),
    };
    const approval = fixture({ ownerSnapshot });
    approval.actions.set(
      actionRef,
      caseAction({
        repairTarget: {
          featureId: 'F100',
          componentId: 'capability:development-process-harness-effectiveness',
          version: targetVersionRef.version,
        },
      }),
    );
    const proposed = await proposeAndAccept(approval, ownerLineage);
    assert.equal((await approval.service.materialize(proposed.proposalId)).status, 'materialized');

    const task = {
      id: 'f313:1',
      status: 'doing',
      ownerCatId: 'codex-sol',
      threadId: 'thread-f313',
      userId: 'owner-user',
    };
    const lease = {
      leaseId: 'f313',
      generation: 1,
      status: 'active',
      subjectRef: `subject:task:${task.id}`,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      holderCatIds: ['codex-sol'],
      holderThreadId: task.threadId,
      tenantScope: task.userId,
      terminalPredicate: { kind: 'task_done' },
    };
    const events = await approval.eventLog.read(caseAction().caseId);
    await approval.eventLog.append(
      {
        eventId: 'f266:test:responsibility',
        caseId: caseAction().caseId,
        verdictId: caseAction().verdictId,
        domainId: 'eval:friction',
        type: 'responsibility_bound',
        actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
        occurredAt: '2026-09-12T10:05:00.000Z',
        reason: 'active owner responsibility',
        refs: [
          { kind: 'task', availability: 'available', value: `task:${task.id}` },
          { kind: 'other', availability: 'available', value: `action-successor:${lease.leaseId}:1` },
          { kind: 'other', availability: 'available', value: `message:${principal.originMessageId}` },
        ],
        taskId: task.id,
        leaseId: lease.leaseId,
        leaseGeneration: lease.generation,
      },
      events.length,
    );
    const records = new Map([
      [
        principal.invocationId,
        {
          ...principal,
          ownerAuthProvenance: 'strict',
          state: 'active',
          originTriggerMessageId: principal.originMessageId,
        },
      ],
      [
        'inv-same-holder-wrong-carrier',
        {
          ...principal,
          invocationId: 'inv-same-holder-wrong-carrier',
          ownerAuthProvenance: 'strict',
          state: 'active',
          originTriggerMessageId: 'unrelated-owner-message',
        },
      ],
    ]);
    const authority = new RequestReviewOwnerFactAuthority({
      eventLog: approval.eventLog,
      taskStore: { get: async (id) => (id === task.id ? task : null) },
      leaseStore: { get: async (id) => (id === lease.leaseId ? lease : null) },
      invocationRegistry: { peekRecord: async (id) => records.get(id) ?? null },
      lineageBindingResolver: {
        async resolveProposalScope() {
          return { status: 'resolved', caseActionRef: actionRef };
        },
      },
    });

    assert.deepEqual(await authority.authorize({ proposalId: proposed.proposalId, principal }), {
      status: 'authorized',
    });
    assert.deepEqual(
      await authority.authorize({
        proposalId: proposed.proposalId,
        principal: { ...principal, catId: 'codex-terra' },
      }),
      { status: 'blocked', reason: 'owner_custody_mismatch' },
    );
    assert.deepEqual(
      await authority.authorize({
        proposalId: proposed.proposalId,
        principal: records.get('inv-same-holder-wrong-carrier'),
      }),
      { status: 'blocked', reason: 'owner_custody_mismatch' },
      'a strict same-cat/thread invocation is not the F266 responsibility carrier holder',
    );
    task.status = 'done';
    assert.deepEqual(await authority.authorize({ proposalId: proposed.proposalId, principal }), {
      status: 'blocked',
      reason: 'owner_custody_inactive',
    });
  });
});
