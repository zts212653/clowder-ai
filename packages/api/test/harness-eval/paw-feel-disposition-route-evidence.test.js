import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ActionSubjectTruthResolver } from '../../dist/domains/ball-custody/ActionSubjectTruthResolver.js';
import { ActionSuccessorAdmissionService } from '../../dist/domains/ball-custody/ActionSuccessorAdmissionService.js';
import { claimActionSuccessor } from '../../dist/domains/ball-custody/action-successor-state-machine.js';
import { PawFeelFixEvidenceResolver } from '../../dist/infrastructure/harness-eval/paw-feel-disposition/route-evidence-resolver.js';

function lease(overrides = {}) {
  return {
    leaseId: 'lease-1',
    subjectRef: 'subject:task:task-1',
    mode: 'single',
    holderCatIds: ['opus'],
    holderThreadId: 'thread-owner',
    generation: 3,
    status: 'active',
    ...overrides,
  };
}

function task(overrides = {}) {
  return {
    id: 'task-1',
    threadId: 'thread-owner',
    ownerCatId: 'opus',
    status: 'doing',
    ...overrides,
  };
}

function resolver({ storedLease = lease(), storedTask = task(), preflight = { ok: true, reason: 'active' } } = {}) {
  return new PawFeelFixEvidenceResolver({
    leaseStore: {
      async get() {
        return storedLease;
      },
      async preflight() {
        return preflight;
      },
    },
    taskStore: {
      async get() {
        return storedTask;
      },
    },
  });
}

describe('PawFeelFixEvidenceResolver', () => {
  it('accepts the lease produced by real task-backed existing-standing admission', async () => {
    const storedTask = task({ userId: 'user-1', updatedAt: 210 });
    let storedLease = null;
    const leaseStore = {
      async get() {
        return storedLease;
      },
      async getSubjectTerminal() {
        return null;
      },
      async markSubjectTerminal(input) {
        return {
          subjectRef: input.subjectRef,
          state: input.state,
          evidenceRef: input.evidenceRef,
          observedAt: input.now,
        };
      },
      async clearSubjectTerminal() {
        return false;
      },
      async claim(input) {
        const claimed = claimActionSuccessor(null, input);
        storedLease = claimed.lease;
        return claimed;
      },
      async preflight(leaseId, generation, predicateDigest) {
        return storedLease?.leaseId === leaseId &&
          storedLease.generation === generation &&
          (!predicateDigest || storedLease.terminalPredicate?.digest === predicateDigest) &&
          storedLease.status === 'active'
          ? { ok: true, reason: 'active' }
          : { ok: false, reason: 'lease_not_active' };
      },
    };
    const truthResolver = new ActionSubjectTruthResolver(
      leaseStore,
      {
        async get() {
          return null;
        },
      },
      undefined,
      {
        async get(taskId) {
          return taskId === storedTask.id ? storedTask : null;
        },
      },
    );
    const admission = new ActionSuccessorAdmissionService(leaseStore, truthResolver);
    const admitted = await admission.admit({
      tenantScope: 'user-1',
      actorCatId: 'opus',
      sourceThreadId: storedTask.threadId,
      targetThreadId: storedTask.threadId,
      holderCatIds: ['opus'],
      dispatchId: 'existing-standing:task-1',
      evidenceRef: 'message:task-claim',
      now: 220,
      action: {
        subjectRef: `subject:task:${storedTask.id}`,
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        claimOrigin: 'existing_standing',
        groundingEvidenceRef: 'message:task-assignment',
        terminalPredicate: { kind: 'task_done' },
      },
    });
    assert.equal(admitted.admit, true);

    const result = await new PawFeelFixEvidenceResolver({
      leaseStore,
      taskStore: {
        async get() {
          return storedTask;
        },
      },
    }).resolve(admitted.lease.leaseId);

    assert.deepEqual(result, {
      ownerCatId: 'opus',
      taskId: 'task-1',
      leaseId: admitted.lease.leaseId,
      leaseGeneration: 1,
      custodyEvidenceRef: `action-lease:${admitted.lease.leaseId}:generation:1`,
    });
  });

  it('resolves a real task, named owner, and active single-successor lease', async () => {
    const result = await resolver().resolve('lease-1');

    assert.deepEqual(result, {
      ownerCatId: 'opus',
      taskId: 'task-1',
      leaseId: 'lease-1',
      leaseGeneration: 3,
      custodyEvidenceRef: 'action-lease:lease-1:generation:3',
    });
  });

  it('fails closed for a missing or inactive transport-only receipt', async () => {
    await assert.rejects(resolver({ storedLease: null }).resolve('delivery-message-1'), /active F167 lease not found/i);
    await assert.rejects(
      resolver({
        storedLease: lease({ status: 'replaceable' }),
        preflight: { ok: false, reason: 'lease_not_active' },
      }).resolve('lease-1'),
      /lease_not_active/i,
    );
  });

  it('rejects parallel holders and non-task subjects', async () => {
    await assert.rejects(
      resolver({
        storedLease: lease({ mode: 'parallel', holderCatIds: ['opus', 'kimi'] }),
      }).resolve('lease-1'),
      /single named holder/i,
    );
    await assert.rejects(
      resolver({ storedLease: lease({ subjectRef: 'subject:feature:F278' }) }).resolve('lease-1'),
      /task subject/i,
    );
  });

  it('rejects closed tasks and owner or thread mismatches', async () => {
    await assert.rejects(resolver({ storedTask: task({ status: 'done' }) }).resolve('lease-1'), /task is done/i);
    await assert.rejects(
      resolver({ storedTask: task({ ownerCatId: 'kimi' }) }).resolve('lease-1'),
      /task owner does not match/i,
    );
    await assert.rejects(
      resolver({ storedTask: task({ threadId: 'thread-other' }) }).resolve('lease-1'),
      /task thread does not match/i,
    );
  });
});
