/**
 * F233 PR3 — taskStore.update source events.
 */

import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';

describe('F233 PR3: BallCustodyTaskStore', () => {
  test('completes the exact active task lease and recovers a persisted done task idempotently', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { withBallCustodyTaskEvents } = await import('../dist/domains/ball-custody/BallCustodyTaskStore.js');
    const { TaskActionSuccessorLifecycle } = await import(
      '../dist/domains/ball-custody/TaskActionSuccessorLifecycle.js'
    );
    const rawStore = new TaskStore();
    const task = await rawStore.create({
      threadId: 'thread-task',
      title: 'Implement the fix',
      why: 'task-backed executable custody',
      ownerCatId: 'opus',
      userId: 'user-1',
      createdBy: 'codex-sol',
    });
    const lease = {
      leaseId: 'lease-task-1',
      generation: 1,
      status: 'active',
      tenantScope: 'user-1',
      subjectRef: `subject:task:${task.id}`,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      holderCatIds: ['opus'],
      holderThreadId: 'thread-task',
      terminalPredicate: { kind: 'task_done' },
    };
    const leaseStore = {
      getByIdentity: mock.fn(async () => lease),
      listActiveTaskLeases: mock.fn(async () => [lease]),
    };
    const completionService = {
      complete: mock.fn(async () => ({ outcome: 'committed', leaseId: lease.leaseId, generation: 1 })),
    };
    const lifecycle = new TaskActionSuccessorLifecycle({ leaseStore, completionService });
    const store = withBallCustodyTaskEvents(rawStore, { async record() {} }, undefined, lifecycle);

    const done = await store.update(task.id, { status: 'done' });
    assert.equal(done.status, 'done');
    assert.deepEqual(completionService.complete.mock.calls[0].arguments[0], {
      leaseId: 'lease-task-1',
      generation: 1,
      catId: 'opus',
      evidenceRefs: [`task:${task.id}:done:${done.updatedAt}`],
      now: done.updatedAt,
    });

    const stats = await lifecycle.reconcileDoneTasks(rawStore);
    assert.deepEqual(stats, { scanned: 1, attempted: 1, committed: 1, skipped: 0, errored: 0 });
    assert.equal(
      completionService.complete.mock.calls.length,
      2,
      'recovery retries through the idempotent completion service',
    );
  });

  test('does not let task owner, thread, or deletion orphan an active task lease', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { withBallCustodyTaskEvents } = await import('../dist/domains/ball-custody/BallCustodyTaskStore.js');
    const { TaskActionSuccessorLifecycle } = await import(
      '../dist/domains/ball-custody/TaskActionSuccessorLifecycle.js'
    );
    const rawStore = new TaskStore();
    const task = await rawStore.create({
      threadId: 'thread-task',
      title: 'Implement the fix',
      why: 'task-backed executable custody',
      ownerCatId: 'opus',
      userId: 'user-1',
      createdBy: 'codex-sol',
    });
    const leaseStore = {
      async getByIdentity() {
        return { status: 'active', leaseId: 'lease-task-1' };
      },
      async listActiveTaskLeases() {
        return [];
      },
    };
    const lifecycle = new TaskActionSuccessorLifecycle({
      leaseStore,
      completionService: {
        async complete() {
          throw new Error('not reached');
        },
      },
    });
    const store = withBallCustodyTaskEvents(rawStore, { async record() {} }, undefined, lifecycle);

    await assert.rejects(store.update(task.id, { ownerCatId: 'codex-sol' }), /active task action lease/);
    await assert.rejects(store.update(task.id, { threadId: 'thread-other' }), /active task action lease/);
    await assert.rejects(store.delete(task.id), /active task action lease/);
    assert.equal((await rawStore.get(task.id)).ownerCatId, 'opus');
    assert.equal((await rawStore.get(task.id)).threadId, 'thread-task');
  });

  test('retries lease completion when the durable task was already written done', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { withBallCustodyTaskEvents } = await import('../dist/domains/ball-custody/BallCustodyTaskStore.js');
    const { TaskActionSuccessorLifecycle } = await import(
      '../dist/domains/ball-custody/TaskActionSuccessorLifecycle.js'
    );
    const rawStore = new TaskStore();
    const task = await rawStore.create({
      threadId: 'thread-task',
      title: 'Retry completion',
      why: 'cover the durable task write before completion CAS window',
      ownerCatId: 'opus',
      userId: 'user-1',
      createdBy: 'codex-sol',
    });
    const lease = {
      leaseId: 'lease-task-retry',
      generation: 1,
      status: 'active',
      subjectRef: `subject:task:${task.id}`,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      holderCatIds: ['opus'],
      holderThreadId: 'thread-task',
      terminalPredicate: { kind: 'task_done' },
    };
    let completionAttempts = 0;
    const lifecycle = new TaskActionSuccessorLifecycle({
      leaseStore: {
        async getByIdentity() {
          return lease;
        },
        async listActiveTaskLeases() {
          return [lease];
        },
      },
      completionService: {
        async complete() {
          completionAttempts += 1;
          return completionAttempts === 1
            ? { outcome: 'insufficient', reason: 'simulated crash-window failure' }
            : { outcome: 'committed', leaseId: lease.leaseId, generation: 1 };
        },
      },
    });
    const store = withBallCustodyTaskEvents(rawStore, { async record() {} }, undefined, lifecycle);

    await assert.rejects(store.update(task.id, { status: 'done' }), /simulated crash-window failure/);
    assert.equal((await rawStore.get(task.id)).status, 'done', 'task write is already durable');
    assert.equal((await store.update(task.id, { status: 'done' })).status, 'done');
    assert.equal(completionAttempts, 2);
  });

  test('records task.blocked, task.unblocked, and task.done from status transitions', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { withBallCustodyTaskEvents } = await import('../dist/domains/ball-custody/BallCustodyTaskStore.js');
    const events = [];
    const store = withBallCustodyTaskEvents(new TaskStore(), {
      async record(event) {
        events.push(event);
      },
    });

    const task = await store.create({
      threadId: 'thr-task',
      title: 'Wait for review',
      why: 'PR needs external review',
      ownerCatId: 'opus',
      createdBy: 'codex',
    });

    await store.update(task.id, { title: 'Wait for review - updated' });
    assert.equal(events.length, 0, 'non-status updates must not emit ball-custody events');

    const blocked = await store.update(task.id, { status: 'blocked' });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.blocked');
    assert.equal(events[0].sourceEventId, `task:${task.id}:blocked:${blocked.updatedAt}`);
    assert.equal(events[0].subjectKey, `ball:task:${task.id}`);
    assert.deepEqual(events[0].payload, {
      taskId: task.id,
      threadId: 'thr-task',
      ownerCatId: 'opus',
    });

    const unblocked = await store.update(task.id, { status: 'doing' });
    assert.equal(events.length, 2);
    assert.equal(events[1].kind, 'task.unblocked');
    assert.equal(events[1].sourceEventId, `task:${task.id}:unblocked:${unblocked.updatedAt}`);

    const done = await store.update(task.id, { status: 'done' });
    assert.equal(events.length, 3);
    assert.equal(events[2].kind, 'task.done');
    assert.equal(events[2].sourceEventId, `task:${task.id}:done`);
    assert.equal(events[2].at, done.updatedAt);
  });

  test('task.blocked carries resolveMode from task metadata', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { withBallCustodyTaskEvents } = await import('../dist/domains/ball-custody/BallCustodyTaskStore.js');
    const events = [];
    const store = withBallCustodyTaskEvents(new TaskStore(), {
      async record(event) {
        events.push(event);
      },
    });

    const task = await store.create({
      threadId: 'thr-probe',
      title: 'Wait for endpoint',
      why: 'wake me when endpoint is ready',
      ownerCatId: 'codex',
      createdBy: 'codex',
      resolveMode: 'bounces_back',
      probe: { kind: 'http_get', url: 'http://127.0.0.1:3102/health', expectStatus: 200 },
    });

    const blocked = await store.update(task.id, { status: 'blocked' });

    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'task.blocked');
    assert.equal(blocked.resolveMode, 'bounces_back');
    assert.deepEqual(events[0].payload, {
      taskId: task.id,
      threadId: 'thr-probe',
      ownerCatId: 'codex',
      resolveMode: 'bounces_back',
    });
  });

  test('records task.done, not task.unblocked, when blocked task completes', async () => {
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { withBallCustodyTaskEvents } = await import('../dist/domains/ball-custody/BallCustodyTaskStore.js');
    const events = [];
    const store = withBallCustodyTaskEvents(new TaskStore(), {
      async record(event) {
        events.push(event);
      },
    });

    const task = await store.create({
      threadId: 'thr-task-done',
      title: 'Finish feature',
      why: 'done should resolve the ball',
      ownerCatId: 'codex',
      createdBy: 'codex',
    });

    await store.update(task.id, { status: 'blocked' });
    await store.update(task.id, { status: 'done' });

    assert.deepEqual(
      events.map((event) => event.kind),
      ['task.blocked', 'task.done'],
    );
  });
});
