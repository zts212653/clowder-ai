import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.js';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/task/plugin-task-host.js';

function fixture() {
  const taskStore = new TaskStore();
  const threadStore = new ThreadStore();
  const keeper = threadStore.create('owner', 'Intake');
  const child = threadStore.create('owner', 'Implementation');
  threadStore.updateThreadKind(keeper.id, 'gate-keeping');
  const deps = {
    pluginId: 'example',
    pluginInstanceId: 'instance',
    taskStore,
    threadStore,
  };
  const host = createPluginTaskHost(deps);
  const caller = {
    invocationId: 'inv',
    userId: 'owner',
    catId: 'codex',
    threadId: keeper.id,
    sourceMessageId: 'message',
    source: { kind: 'primary' as const, sourceMessageId: 'message' },
    assertCurrent: async () => {},
  };
  const native = <T>(run: () => Promise<T>) => withPluginCallContext('instance', caller, run);
  const input = (kind: 'pr_tracking' | 'issue_tracking', threadId = keeper.id) => ({
    threadId,
    title: 'External subject',
    kind,
    ownerCatId: 'codex',
    subjectKey: `${kind === 'pr_tracking' ? 'pr' : 'issue'}:fixture/repo#1`,
  });
  return { taskStore, threadStore, keeper, child, host, caller, native, input };
}

for (const onConflict of ['error', 'update'] as const) {
  test(`${onConflict}: gate-keeping rejects implementation tracking before creating a task`, async () => {
    const f = fixture();
    await assert.rejects(
      f.native(() => f.host.create(f.input('pr_tracking'), { onConflict })),
      /gate.keeping/i,
    );
    assert.equal(f.taskStore.listByThread(f.keeper.id).length, 0);
  });

  test(`${onConflict}: keeper cannot take an issue already owned by another thread`, async () => {
    const f = fixture();
    const existing = f.taskStore.create({
      ...f.input('issue_tracking', f.child.id),
      createdBy: 'system',
      userId: 'owner',
    });
    await assert.rejects(
      f.native(() => f.host.create(f.input('issue_tracking'), { onConflict })),
      /gate.keeping/i,
    );
    assert.deepEqual(f.taskStore.get(existing.id), existing);
    assert.equal(f.taskStore.listByThread(f.keeper.id).length, 0);
  });

  test(`${onConflict}: keeper may register a new issue and replay its own issue`, async () => {
    const f = fixture();
    const task = await f.native(() => f.host.create(f.input('issue_tracking'), { onConflict }));
    assert.equal(task.threadId, f.keeper.id);
    const replay = await f.native(() => f.host.create(f.input('issue_tracking'), { onConflict: 'update' }));
    assert.equal(replay.id, task.id);
  });
}

test('ownership lookup failure cannot authorize a keeper issue registration', async () => {
  const f = fixture();
  f.taskStore.getBySubject = () => {
    throw new Error('store unavailable');
  };
  await assert.rejects(
    f.native(() => f.host.create(f.input('issue_tracking'))),
    /gate.keeping/i,
  );
  assert.equal(f.taskStore.listByThread(f.keeper.id).length, 0);
});

test('package-selected destination cannot bypass the authenticated source thread policy', async () => {
  const f = fixture();
  await assert.rejects(
    f.native(() => f.host.create(f.input('pr_tracking', f.child.id))),
    /gate.keeping/i,
  );
  assert.equal(f.taskStore.listByThread(f.child.id).length, 0);
});

test('setWait rejects a pre-existing implementation task in a keeper thread', async () => {
  const f = fixture();
  const task = f.taskStore.create({ ...f.input('pr_tracking'), createdBy: 'system', userId: 'owner' });
  await assert.rejects(
    f.native(() =>
      f.host.update(task.id, {
        wait: {
          expectedGeneration: null,
          generation: 1,
          active: {},
        },
      }),
    ),
    /gate.keeping/i,
  );
  assert.equal(f.taskStore.get(task.id)?.pluginWait, undefined);
});

for (const method of ['update', 'updateIfThreadId'] as const) {
  test(`${method}: moving an implementation task cannot bypass keeper policy`, async () => {
    const f = fixture();
    const task = f.taskStore.create({ ...f.input('pr_tracking', f.child.id), createdBy: 'system' });
    const patch = { threadId: f.keeper.id };
    await assert.rejects(
      f.native(() =>
        method === 'update'
          ? f.host.update(task.id, patch)
          : f.host.update(task.id, patch, { expectedThreadId: f.child.id }),
      ),
      /gate.keeping/i,
    );
    assert.equal(f.taskStore.get(task.id)?.threadId, f.child.id);
  });
}

test('ordinary threads retain implementation tracking and generic keeper tasks remain available', async () => {
  const f = fixture();
  const task = await withPluginCallContext('instance', { ...f.caller, threadId: f.child.id }, () =>
    f.host.create(f.input('pr_tracking', f.child.id)),
  );
  assert.equal(task.threadId, f.child.id);
  const work = await f.native(() => f.host.create({ threadId: f.keeper.id, title: 'Intake work', kind: 'work' }));
  assert.equal(work.kind, 'work');
});

test('a generic upsert cannot disguise the stored implementation task kind', async () => {
  const f = fixture();
  const task = f.taskStore.create({ ...f.input('pr_tracking'), createdBy: 'system', userId: 'owner' });
  await assert.rejects(
    f.native(() => f.host.create({ ...f.input('pr_tracking'), kind: 'work' }, { onConflict: 'update' })),
    /gate.keeping/i,
  );
  assert.deepEqual(f.taskStore.get(task.id), task);
});

test('background renewal rechecks thread governance but terminal delivery repair remains possible', async () => {
  const f = fixture();
  f.threadStore.updateThreadKind(f.keeper.id, null);
  const task = await f.native(() => f.host.create(f.input('pr_tracking')));
  const registered = await f.native(() =>
    f.host.update(task.id, {
      wait: {
        expectedGeneration: null,
        generation: 1,
        active: {},
      },
    }),
  );
  f.threadStore.updateThreadKind(f.keeper.id, 'gate-keeping');
  await assert.rejects(
    f.host.update(task.id, { wait: { expectedGeneration: 1, generation: 2, active: {} } }),
    /gate.keeping/i,
  );
  assert.deepEqual(f.taskStore.get(task.id)?.pluginWait, registered?.pluginWait);
  const terminal = await f.host.update(task.id, {
    wait: {
      expectedGeneration: 1,
      generation: 1,
      active: null,
      outcome: {
        outcomeId: 'cancelled',
        generation: 1,
        ownerFence: { kind: 'containing_task', generation: 1 },
        reason: 'user_cancel',
        delivery: 'not_applicable',
      },
    },
  });
  assert.equal(terminal?.pluginWait?.await, undefined);
  assert.deepEqual(terminal?.pluginWait?.registration, registered?.pluginWait?.registration);
});
