import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MemoryRequestReviewOwnerLedger } from '../dist/infrastructure/capability-evolution/adapters/request-review/request-review-owner-ledger.js';
import { RequestReviewCanonicalRepairDispatcher } from '../dist/infrastructure/capability-evolution/change/request-review-canonical-dispatcher.js';
import {
  actionRef,
  caseAction,
  caseId,
  fixture,
  MemoryEventLog,
  proposeAndAccept,
  ref,
  verdictId,
} from './harness-eval/eval-repair-approval-fixtures.js';

const targetVersionRef = {
  ownerFeatureId: 'F100',
  ownerStateRef: 'skill:cat-cafe-skills/request-review/SKILL.md',
  version: 'a'.repeat(64),
  assetKind: 'skill',
  assetId: 'cat-cafe-skills/request-review/SKILL.md',
};
const ownerSnapshot = {
  status: 'resolved',
  ownerRef: ref('F100', 'owner:request-review'),
  ownerAuthorizationRef: ref('F100', `authorization:request-review:${targetVersionRef.version}`),
  targetVersionRef,
  dispatchRef: ref('F100', `dispatch:request-review:${targetVersionRef.version}`),
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

function custodyFixture(
  eventLog,
  ledger,
  resolveCurrentSnapshot = async () => ownerSnapshot,
  resolveProposalScope = async () => ({ status: 'resolved', caseActionRef: actionRef }),
) {
  const task = {
    id: 'task-f100-case',
    threadId: 'thread-f100',
    status: 'doing',
    ownerCatId: 'codex-sol',
    userId: 'owner-user',
  };
  const lease = {
    leaseId: 'lease-f100-case',
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
  const reads = { task: 0, lease: 0 };
  const dispatcher = new RequestReviewCanonicalRepairDispatcher({
    eventLog,
    ledger,
    taskStore: {
      async get(taskId) {
        reads.task += 1;
        return taskId === task.id ? task : null;
      },
    },
    leaseStore: {
      async get(leaseId) {
        reads.lease += 1;
        return leaseId === lease.leaseId ? lease : null;
      },
    },
    lineageBindingResolver: {
      resolveProposalScope,
    },
    resolveCurrentSnapshot,
    now: () => '2026-09-12T10:10:00.000Z',
  });
  return { dispatcher, task, lease, reads };
}

async function bindResponsibility(eventLog, task, lease) {
  const events = await eventLog.read(caseId);
  await eventLog.append(
    {
      eventId: `f266:${caseId}:cycle:${verdictId}:responsibility`,
      caseId,
      verdictId,
      domainId: 'eval:friction',
      type: 'responsibility_bound',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      occurredAt: '2026-09-12T10:05:00.000Z',
      reason: 'durable responsibility already owns the repair task',
      refs: [
        { kind: 'task', availability: 'available', value: `task:${task.id}` },
        { kind: 'other', availability: 'available', value: `action-successor:${lease.leaseId}:1` },
      ],
      taskId: task.id,
      leaseId: lease.leaseId,
      leaseGeneration: lease.generation,
    },
    events.length,
  );
}

async function approvedFixture(resolveCurrentSnapshot, resolveProposalScope) {
  const eventLog = new MemoryEventLog();
  const ledger = new MemoryRequestReviewOwnerLedger();
  const custody = custodyFixture(eventLog, ledger, resolveCurrentSnapshot, resolveProposalScope);
  let dispatchedInput;
  const approval = fixture({
    eventLog,
    ownerSnapshot,
    canonicalRepairDispatcher: {
      async materialize(input) {
        dispatchedInput = structuredClone(input);
        return custody.dispatcher.materialize(input);
      },
    },
  });
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
  await bindResponsibility(eventLog, custody.task, custody.lease);
  return { approval, proposed, eventLog, ledger, custody, dispatchedInput: () => dispatchedInput };
}

describe('F100 canonical F266 dispatcher', () => {
  it('reuses one stable Task/F167 custody and returns the same receipt on retry', async () => {
    const ctx = await approvedFixture();
    const first = await ctx.approval.service.materialize(ctx.proposed.proposalId);
    assert.equal(first.status, 'materialized');
    const duplicate = await ctx.approval.service.materialize(ctx.proposed.proposalId);
    assert.equal(duplicate.status, 'duplicate');
    assert.deepEqual(duplicate.receipt, first.receipt);
    assert.equal((await ctx.ledger.read()).filter((event) => event.type === 'dispatch_reserved').length, 1);
    assert.equal(first.receipt.taskRef.ownerStateRef, `task:${ctx.custody.task.id}`);
    assert.match(first.receipt.leaseRef.ownerStateRef, new RegExp(ctx.custody.lease.leaseId));
  });

  it('rejects target drift before writing any F100 dispatch fact', async () => {
    const drifted = {
      ...ownerSnapshot,
      targetVersionRef: { ...targetVersionRef, version: 'b'.repeat(64) },
      ownerAuthorizationRef: ref('F100', `authorization:request-review:${'b'.repeat(64)}`),
      dispatchRef: ref('F100', `dispatch:request-review:${'b'.repeat(64)}`),
    };
    const ctx = await approvedFixture(async () => drifted);
    const result = await ctx.approval.service.materialize(ctx.proposed.proposalId);
    assert.equal(result.status, 'superseded');
    assert.equal(result.drift, 'authorization');
    assert.equal((await ctx.ledger.read()).length, 0);
  });

  it('rejects a foreign proposal scope before reserving an F100 dispatch', async () => {
    const ctx = await approvedFixture(undefined, async () => ({
      status: 'blocked',
      reason: 'lineage_mismatch',
    }));
    const result = await ctx.approval.service.materialize(ctx.proposed.proposalId);
    assert.equal(result.status, 'blocked');
    assert.equal(result.reason, 'owner_authorization_unreadable');
    assert.deepEqual(await ctx.ledger.read(), []);
    assert.deepEqual(ctx.custody.reads, { task: 0, lease: 0 });
  });

  it('recovers the exact receipt after an owner response is lost and the dispatcher is reconstructed', async () => {
    const ctx = await approvedFixture();
    const first = await ctx.approval.service.materialize(ctx.proposed.proposalId);
    assert.equal(first.status, 'materialized');
    const restarted = custodyFixture(ctx.eventLog, ctx.ledger).dispatcher;
    const replay = await restarted.materialize(ctx.dispatchedInput());
    assert.equal(replay.status, 'materialized');
    assert.deepEqual(replay.receipt, first.receipt);
    assert.equal((await ctx.ledger.read()).filter((event) => event.type === 'dispatch_reserved').length, 1);
  });
});
