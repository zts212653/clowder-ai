import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

describe('TaskActionSuccessorLifecycle recovery isolation', () => {
  test('continues after an orphan lease and completes the next task lease', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { TaskActionSuccessorLifecycle } = await import(
      '../dist/domains/ball-custody/TaskActionSuccessorLifecycle.js'
    );
    const taskStore = new TaskStore();
    const orphanTask = await taskStore.create({
      threadId: 'thread-orphan',
      title: 'Orphaned recovery candidate',
      ownerCatId: 'opus',
      userId: 'user-1',
      createdBy: 'codex-sol',
    });
    const validTask = await taskStore.create({
      threadId: 'thread-valid',
      title: 'Valid recovery candidate',
      ownerCatId: 'sonnet',
      userId: 'user-1',
      createdBy: 'codex-sol',
    });
    const orphanDone = await taskStore.update(orphanTask.id, { status: 'done' });
    const validDone = await taskStore.update(validTask.id, { status: 'done' });
    const orphanLease = {
      leaseId: 'lease-orphan',
      generation: 1,
      status: 'active',
      subjectRef: `subject:task:${orphanDone.id}`,
      holderCatIds: ['different-owner'],
      holderThreadId: orphanDone.threadId,
      terminalPredicate: { kind: 'task_done' },
    };
    const validLease = {
      leaseId: 'lease-valid',
      generation: 1,
      status: 'active',
      subjectRef: `subject:task:${validDone.id}`,
      holderCatIds: [validDone.ownerCatId],
      holderThreadId: validDone.threadId,
      terminalPredicate: { kind: 'task_done' },
    };
    const completionService = {
      complete: mock.fn(async () => ({
        outcome: 'committed',
        leaseId: validLease.leaseId,
        generation: validLease.generation,
      })),
    };
    const lifecycle = new TaskActionSuccessorLifecycle({
      leaseStore: {
        async getByIdentity() {
          return null;
        },
        async listActiveTaskLeases() {
          return [orphanLease, validLease];
        },
      },
      completionService,
    });

    const stats = await lifecycle.reconcileDoneTasks(taskStore);

    assert.deepEqual(stats, { scanned: 2, attempted: 2, committed: 1, skipped: 0, errored: 1 });
    assert.equal(completionService.complete.mock.calls.length, 1);
    assert.equal(completionService.complete.mock.calls[0].arguments[0].leaseId, validLease.leaseId);
  });
});
