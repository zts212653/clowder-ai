/**
 * F233 PR3 — taskStore.update source events.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('F233 PR3: BallCustodyTaskStore', () => {
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
