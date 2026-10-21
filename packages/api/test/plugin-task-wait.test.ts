import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBallCustodyTaskEvents } from '../src/domains/ball-custody/BallCustodyTaskStore.js';
import { resolveTypedWaitContinuation } from '../src/domains/ball-custody/TypedWaitContinuation.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { withPluginCallContext } from '../src/domains/plugin/carrier/plugin-call-context.js';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/task/plugin-task-host.js';

const identity = {
  invocationId: 'inv',
  userId: 'owner',
  catId: 'codex',
  threadId: 'thread',
  sourceMessageId: 'message',
};
const caller = {
  ...identity,
  source: { kind: 'primary' as const, sourceMessageId: 'message' },
  assertCurrent: async () => {},
};
const initial = { expectedGeneration: null, generation: 1, active: {} };
function fixture() {
  const store = new TaskStore();
  const host = createPluginTaskHost({
    pluginId: 'example',
    pluginInstanceId: 'instance',
    ownerUserId: 'owner',
    effectiveGrants: ['task.read', 'task.write'],
    taskStore: store,
  });
  const native = <T>(run: () => Promise<T>) => withPluginCallContext('instance', caller, run);
  return { store, host, native };
}

for (const kind of ['pr_tracking', 'issue_tracking'] as const) {
  test(`done ${kind} accepts first terminal repair but never an active wait or a rebound receipt`, async () => {
    const { store, host, native } = fixture();
    const task = await native(() =>
      host.create({
        threadId: 'thread',
        ownerCatId: 'codex',
        title: 'Completed tracking',
        kind,
        subjectKey: `${kind === 'pr_tracking' ? 'pr' : 'issue'}:fixture/repo#1`,
      }),
    );
    await store.update(task.id, { status: 'done' });
    const terminal = {
      ...initial,
      active: null,
      outcome: {
        outcomeId: 'terminal',
        generation: 1,
        ownerFence: { kind: 'containing_task' as const, generation: 1 },
        reason: 'subject_terminal' as const,
        delivery: 'pending' as const,
      },
    };
    await assert.rejects(host.update(task.id, { wait: terminal }), /authenticated/);
    assert.equal(await native(() => host.update(task.id, { wait: initial })), null);
    assert.equal(await native(() => host.update(task.id, { wait: { ...initial, active: null } })), null);
    assert.equal(store.get(task.id)!.pluginWait, undefined);
    const repaired = await native(() => host.update(task.id, { wait: terminal }));
    assert.ok(repaired, 'first terminal projection must repair the failed initial publication');
    assert.equal(repaired.status, 'done');
    assert.equal(repaired.pluginWait?.await, undefined);
    assert.equal(repaired.pluginWait?.waitOutcome?.outcomeId, 'terminal');
    assert.equal(repaired.pluginWait?.registration?.invocationId, caller.invocationId);
    const replay = await withPluginCallContext(
      'instance',
      {
        ...caller,
        invocationId: 'retry-turn',
        source: { kind: 'primary', sourceMessageId: 'new-source' },
      },
      () => host.update(task.id, { wait: { ...terminal, expectedGeneration: 1 } }),
    );
    assert.deepEqual(replay?.pluginWait, repaired.pluginWait);
    assert.equal(await native(() => host.update(task.id, { wait: terminal })), null, 'stale CAS is rejected');
    await assert.rejects(
      withPluginCallContext('instance', { ...caller, userId: 'other' }, () =>
        host.update(task.id, { wait: { ...terminal, expectedGeneration: 1 } }),
      ),
      /another/,
    );
  });
}

test('authenticated plugin wait supports exact-source continuation and durable outcomes without provider state', async () => {
  const { store, host, native } = fixture();
  const task = await native(() =>
    host.create({ threadId: 'thread', ownerCatId: 'codex', title: 'External event', kind: 'work' }),
  );
  assert.equal(task.userId, 'owner');
  await native(() => host.update(task.id, { wait: initial }));
  const saved = await host.get({ id: task.id });
  assert.equal(saved?.automationState, undefined);
  assert.equal(saved?.deploymentWait, undefined);
  assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'bypass');
  assert.equal(
    (await resolveTypedWaitContinuation({ taskStore: store, ...identity, invocationId: 'other' })).kind,
    'reject',
  );
  const outcome = {
    outcomeId: 'outcome',
    generation: 1,
    ownerFence: { kind: 'containing_task' as const, generation: 1 },
    reason: 'matched' as const,
    delivery: 'pending' as const,
  };
  await host.update(task.id, { wait: { expectedGeneration: 1, generation: 1, active: null, outcome } });
  assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'reject');
  assert.equal(store.get(task.id)!.pluginWait!.waitOutcome?.outcomeId, 'outcome');
  await host.update(task.id, { wait: { expectedGeneration: 1, generation: 2, active: {} } });
  assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'reject');
  assert.equal(await host.update(task.id, { wait: { expectedGeneration: 1, generation: 1, active: {} } }), null);
});

test('wait projection binds its instance and owner and requires authenticated first registration', async () => {
  const { store, host, native } = fixture();
  const task = await native(() => host.create({ threadId: 'thread', ownerCatId: 'codex', title: 'Wait' }));
  await assert.rejects(host.update(task.id, { wait: initial }));
  await native(() => host.update(task.id, { wait: initial }));
  const other = createPluginTaskHost({
    pluginId: 'other',
    pluginInstanceId: 'other',
    effectiveGrants: ['task.write'],
    taskStore: store,
  });
  await assert.rejects(other.update(task.id, { wait: { expectedGeneration: 1, generation: 1, active: null } }));
  await store.update(task.id, { ownerCatId: 'opus' as never });
  await assert.rejects(host.update(task.id, { wait: { expectedGeneration: 1, generation: 2, active: {} } }));
});

test('renewal can retain the preceding outcome; exact replay never rebinds an existing registration', async () => {
  const { store, host, native } = fixture();
  const task = await native(() =>
    host.create({
      threadId: 'thread',
      ownerCatId: 'codex',
      title: 'Wait',
      kind: 'pr_tracking',
      subjectKey: 'pr:fixture/repo#1',
    }),
  );
  await native(() => host.update(task.id, { wait: initial }));
  const receipt = store.get(task.id)!.pluginWait!.registration;
  await withPluginCallContext('instance', { ...caller, invocationId: 'retry-turn' }, () =>
    host.update(task.id, { wait: { ...initial, expectedGeneration: 1 } }),
  );
  assert.deepEqual(store.get(task.id)!.pluginWait!.registration, receipt);
  const outcome = {
    outcomeId: 'old-event',
    generation: 1,
    ownerFence: { kind: 'containing_task' as const, generation: 1 },
    reason: 'matched' as const,
    delivery: 'pending' as const,
  };
  const renewed = await host.update(task.id, { wait: { expectedGeneration: 1, generation: 2, active: {}, outcome } });
  assert.equal(renewed?.pluginWait?.generation, 2);
  assert.equal(renewed?.pluginWait?.waitOutcome?.generation, 1);
  assert.equal(renewed?.pluginWait?.registration, undefined);
  assert.equal(renewed?.pluginWait?.await?.expiresAt, undefined);
  assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'reject');
  await host.update(task.id, { wait: { expectedGeneration: 2, generation: 2, active: {} } });
  assert.equal(store.get(task.id)!.pluginWait!.waitOutcome, undefined, 'omission clears outcome in full snapshot');
  await assert.rejects(
    host.update(task.id, {
      wait: {
        expectedGeneration: 2,
        generation: 2,
        active: {},
        outcome: { ...outcome, ownerFence: { kind: 'action_successor', leaseId: 'forged', generation: 1 } },
      } as never,
    }),
  );
});

test('expiry, concurrent same-generation publication and stale invocation fail closed', async () => {
  const { store, host, native } = fixture();
  const task = await native(() => host.create({ threadId: 'thread', ownerCatId: 'codex', title: 'Wait' }));
  await native(() => host.update(task.id, { wait: { ...initial, active: { expiresAt: Date.now() - 1 } } }));
  assert.equal((await resolveTypedWaitContinuation({ taskStore: store, ...identity })).kind, 'reject');
  const old = store.get(task.id)!.pluginWait!;
  const replacement = { ...old, generation: 2, await: { generation: 2 } };
  assert.ok(
    store.replacePluginWait(task.id, {
      expectedGeneration: 1,
      expectedState: old,
      expectedStatus: store.get(task.id)!.status,
      state: replacement,
    }),
  );
  assert.equal(
    store.replacePluginWait(task.id, {
      expectedGeneration: 2,
      expectedState: old,
      expectedStatus: store.get(task.id)!.status,
      state: replacement,
    }),
    null,
  );
  await assert.rejects(
    withPluginCallContext(
      'instance',
      {
        ...caller,
        assertCurrent: async () => {
          throw Error('stale');
        },
      },
      () => host.update(task.id, { wait: { expectedGeneration: 2, generation: 3, active: {} } }),
    ),
  );
  assert.equal(store.get(task.id)!.pluginWait!.generation, 2);
});

test('tracking status and projection commit together, fencing same-thread owner reassignment', async () => {
  const { store, host, native } = fixture();
  const task = await native(() =>
    host.create({
      threadId: 'thread',
      ownerCatId: 'codex',
      title: 'Wait',
      kind: 'pr_tracking',
      subjectKey: 'pr:fixture/repo#2',
    }),
  );
  const first = await native(() => host.update(task.id, { wait: initial }));
  assert.equal(first?.status, 'doing');
  const replace = store.replacePluginWait.bind(store);
  store.replacePluginWait = (id, input) => {
    store.update(id, { ownerCatId: 'opus' as never });
    return replace(id, input);
  };
  assert.equal(
    await native(() =>
      host.update(task.id, {
        wait: {
          expectedGeneration: 1,
          generation: 1,
          active: null,
          outcome: {
            outcomeId: 'end',
            generation: 1,
            ownerFence: { kind: 'containing_task', generation: 1 },
            reason: 'subject_terminal',
            delivery: 'pending',
          },
        },
      }),
    ),
    null,
  );
  assert.equal(store.get(task.id)?.status, 'doing');
  assert.equal(store.get(task.id)?.ownerCatId, 'opus');
  assert.equal(store.get(task.id)?.pluginWait?.await, undefined);
  assert.equal(store.get(task.id)?.pluginWait?.waitOutcome?.reason, 'owner_changed');
});

for (const mutation of [{ ownerCatId: 'opus' as never }, { threadId: 'new-thread' }, { status: 'done' as const }]) {
  test(`ordinary task mutation revokes wait immediately: ${JSON.stringify(mutation)}`, async () => {
    const { store, host, native } = fixture();
    const task = await native(() =>
      host.create({
        threadId: 'thread',
        ownerCatId: 'codex',
        title: 'Wait',
        kind: 'pr_tracking',
        subjectKey: 'pr:fixture/repo#3',
      }),
    );
    await native(() => host.update(task.id, { wait: initial }));
    const changed = store.update(task.id, mutation)!;
    assert.equal(changed.pluginWait?.await, undefined);
    assert.equal(changed.pluginWait?.registration, undefined);
    assert.equal(changed.pluginWait?.waitOutcome?.reason, 'status' in mutation ? 'user_cancel' : 'owner_changed');
    assert.equal(changed.pluginWait?.waitOutcome?.delivery, 'not_applicable');
    await assert.rejects(host.update(task.id, { wait: { expectedGeneration: 1, generation: 2, active: {} } }));
    const nextCaller = {
      ...caller,
      catId: changed.ownerCatId!,
      threadId: changed.threadId,
      invocationId: 'new-intent',
    };
    const reopened = await withPluginCallContext('instance', nextCaller, () =>
      host.update(task.id, { wait: { expectedGeneration: 1, generation: 2, active: {} } }),
    );
    assert.equal(reopened?.status, 'doing');
    assert.equal(reopened?.pluginWait?.registration?.invocationId, 'new-intent');
    assert.equal(reopened?.pluginWait?.catId, nextCaller.catId);
  });
}

test('a manual done between first projection read and CAS cannot be reopened by the stale registration', async () => {
  const { store, host, native } = fixture();
  const task = await native(() =>
    host.create({
      threadId: 'thread',
      ownerCatId: 'codex',
      title: 'Wait',
      kind: 'pr_tracking',
      subjectKey: 'pr:fixture/repo#4',
    }),
  );
  const replace = store.replacePluginWait.bind(store);
  store.replacePluginWait = (id, input) => {
    store.update(id, { status: 'done' });
    return replace(id, input);
  };
  assert.equal(await native(() => host.update(task.id, { wait: initial })), null);
  assert.equal(store.get(task.id)?.status, 'done');
  assert.equal(store.get(task.id)?.pluginWait, undefined);
});

test('subject upsert cannot reopen a manually completed plugin wait', async () => {
  const { store, host, native } = fixture();
  const input = {
    threadId: 'thread',
    ownerCatId: 'codex' as const,
    title: 'Wait',
    kind: 'pr_tracking' as const,
    subjectKey: 'pr:fixture/repo#5',
  };
  const task = await native(() => host.create(input, { onConflict: 'update' }));
  await native(() => host.update(task.id, { wait: initial }));
  await store.update(task.id, { status: 'done' });
  const replay = await native(() => host.create(input, { onConflict: 'update' }));
  assert.equal(replay.status, 'done');
  assert.equal(replay.pluginWait?.await, undefined);
});

test('atomic wait completion emits task.done once and never emits on rejected CAS', async () => {
  const raw = new TaskStore();
  const events: string[] = [];
  const store = withBallCustodyTaskEvents(raw, {
    record: async (event) => {
      events.push(event.kind);
    },
  } as never);
  const host = createPluginTaskHost({
    pluginId: 'example',
    pluginInstanceId: 'instance',
    effectiveGrants: ['task.write'],
    taskStore: store,
  });
  const task = await withPluginCallContext('instance', caller, () =>
    host.create({
      threadId: 'thread',
      ownerCatId: 'codex',
      title: 'Wait',
      kind: 'pr_tracking',
      subjectKey: 'pr:fixture/repo#6',
    }),
  );
  await withPluginCallContext('instance', caller, () => host.update(task.id, { wait: initial }));
  const terminal = {
    expectedGeneration: 1,
    generation: 1,
    active: null,
    outcome: {
      outcomeId: 'end',
      generation: 1,
      ownerFence: { kind: 'containing_task' as const, generation: 1 },
      reason: 'subject_terminal' as const,
      delivery: 'pending' as const,
    },
  };
  const finished = await host.update(task.id, { wait: terminal });
  assert.equal(finished?.status, 'done');
  await host.update(task.id, { wait: terminal });
  assert.equal(await host.update(task.id, { wait: { ...terminal, expectedGeneration: null } }), null);
  assert.deepEqual(events, ['task.done']);
});

test('conditional wait patch rejects a wrong thread and a thread move at commit without advancing wait state', async () => {
  const { store, host, native } = fixture();
  const task = await native(() =>
    host.create({
      threadId: 'thread',
      title: 'Tracking',
      kind: 'pr_tracking',
      subjectKey: 'pr:fixture/repo#2',
      ownerCatId: 'codex',
    }),
  );
  assert.equal(await native(() => host.update(task.id, { wait: initial }, { expectedThreadId: 'wrong' })), null);
  assert.equal(store.get(task.id)?.pluginWait, undefined);
  const original = store.replacePluginWait.bind(store);
  store.replacePluginWait = (id, input) => {
    store.update(id, { threadId: 'moved' });
    return original(id, input);
  };
  assert.equal(await native(() => host.update(task.id, { wait: initial }, { expectedThreadId: 'thread' })), null);
  assert.equal(store.get(task.id)?.pluginWait, undefined);
});
