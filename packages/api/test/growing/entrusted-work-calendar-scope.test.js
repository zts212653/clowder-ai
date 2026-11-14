import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import '../helpers/setup-cat-registry.js';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { EntrustedWorkLifecycleService } from '../../dist/domains/growing/EntrustedWorkLifecycleService.js';
import { EntrustedWorkOwnerReadService } from '../../dist/domains/growing/EntrustedWorkOwnerReadService.js';
import { NeedsMeProducerCatalog } from '../../dist/domains/growing/NeedsMeProducerCatalog.js';
import { createModuleHostInvocation } from '../../dist/domains/plugin/builtin-runtime/carriers/module-host-invocation.js';
import {
  currentOwnerOperation,
  currentOwnerOperationRequest,
  withCurrentOwnerOperation,
  withOwnerOperationInvocation,
} from '../../dist/domains/plugin/carrier/plugin-owner-operation-context.js';
import { createCollectiveWorkCalendarReader } from '../../dist/domains/plugin/host-surface/collective-work-calendar.js';
import { createPluginTaskHost } from '../../dist/domains/plugin/host-surface/task/plugin-task-host.js';
import { registerEntrustedWorkReadRoutes } from '../../dist/routes/entrusted-work-read-routes.js';

const pluginId = 'official.collective-connector';
const instanceId = 'calendar-instance';
async function fixture(unrelatedCount = 120) {
  const tasks = new TaskStore({ maxTasks: unrelatedCount + 10 });
  const lifecycle = new EntrustedWorkLifecycleService(tasks);
  const admission = await lifecycle.admitOrResume({
    task: {
      threadId: 'owner-thread',
      userId: 'owner',
      ownerCatId: 'codex-sol',
      createdBy: 'user',
      title: 'Original',
      why: 'Keep all facts',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source'],
      intendedOutcome: 'Deliver original',
      idempotencyKey: 'calendar-scope',
    },
    closure: { condition: 'Accepted', expectedSignal: 'result' },
    time: { reviewBy: { value: 1_800_000_000_000, sourceRef: 'message:source' } },
  });
  assert.notEqual(admission.result, 'needs_clarification');
  if (admission.result === 'needs_clarification') throw new Error('admission failed');
  const taskId = admission.ownerRef.slice('task:item:'.length);
  const original = structuredClone(await tasks.get(taskId));
  assert.ok(original?.entrustedWork);
  for (let i = 0; i < unrelatedCount; i++) {
    await tasks.create({
      threadId: 'unrelated',
      userId: 'owner',
      createdBy: 'user',
      ownerCatId: 'codex-sol',
      title: `Other ${i}`,
      why: 'Unrelated',
    });
  }
  let scans = 0,
    gets = 0,
    returned = 0,
    invocations = 0;
  let inventoryFences = 0;
  const tracked = Object.create(tasks);
  tracked.listByKind = (kind) => {
    scans++;
    return tasks.listByKind(kind);
  };
  tracked.get = (id) => {
    gets++;
    return tasks.get(id);
  };
  const host = createPluginTaskHost({
    pluginId,
    pluginInstanceId: instanceId,
    ownerUserId: 'owner',
    taskStore: tracked,
  });
  let release;
  let date = '2027-01-15T08:00:00Z';
  let receivedSelection = false;
  const selections = [];
  const actions = {
    async calendar(input, _native, caller) {
      assert.deepEqual(input, {});
      assert.ok(caller && typeof caller === 'object');
      receivedSelection ||= Object.hasOwn(caller, 'taskReadScope');
      await release?.();
      // Existing installed calendar's unchanged protocol asks for Work tasks.
      const selected = await host.list({ kind: 'work' });
      selections.push(selected.map((task) => task.id));
      returned += selected.length;
      return {
        items: selected
          .filter((task) => task.id === taskId)
          .map((task) => ({
            taskId: task.id,
            taskRevision: task.entrustedWork?.revision,
            serviceInstanceId: 'svc_aaaaaaaa',
            collectiveId: 'col_aaaaaaaa',
            connectionId: 'con_aaaaaaaa',
            serviceUrl: 'http://127.0.0.1:5201',
            location: { channelId: 'general' },
            workId: 'work_aaaaaaaa',
            workRevision: 1,
            time: {
              businessDeadline: {
                value: date,
                timeZone: 'UTC',
                actor: { kind: 'human', humanId: 'human_aaaaaaaa', displayName: 'Owner' },
                at: '2026-10-26T00:00:00Z',
                sourceRef: 'event:evt_aaaaaaaa',
              },
            },
          })),
        unavailableTaskIds: [],
      };
    },
  };
  const invocation = createModuleHostInvocation({ runtime: { actions: () => actions } });
  const calendar = createCollectiveWorkCalendarReader(
    {
      async runAction(id, operationKey, actionId) {
        assert.equal(id, pluginId);
        assert.equal(operationKey, 'calendar');
        assert.equal(actionId, 'read');
        invocations++;
        const request = currentOwnerOperationRequest();
        assert.ok(request);
        const data = await withOwnerOperationInvocation(
          request,
          instanceId,
          'calendar',
          async () => {
            inventoryFences++;
          },
          () => invocation.invoke(instanceId, 'calendar', {}),
        );
        return { matched: true, status: 200, body: { data } };
      },
    },
    'owner',
  );
  const service = new EntrustedWorkOwnerReadService({
    tasks,
    collectiveCalendarReader: calendar,
    producerCatalog: new NeedsMeProducerCatalog([], []),
  });
  return {
    tasks,
    original,
    taskId,
    service,
    calendar,
    host,
    counts: () => ({ scans, gets, returned, invocations }),
    inventoryFenceCount: () => inventoryFences,
    beforeRead: (hook) => {
      release = hook;
    },
    setDate: (value) => {
      date = value;
    },
    publicCallerReceivedSelection: () => receivedSelection,
    selections: () => selections,
  };
}
test('one owner detail reads only its original Task despite hundreds of unrelated Tasks', async () => {
  const f = await fixture(600);
  const read = await f.service.read({
    taskId: f.taskId,
    viewer: { surface: 'cat', userId: 'owner', catId: 'codex-sol', threadId: 'owner-thread' },
  });
  assert.equal(read.envelope.subjectRef, `task:work:${f.taskId}`);
  assert.equal(read.envelope.revision, 1);
  assert.equal(read.work.title, 'Original');
  assert.equal(read.publicTime?.state, 'current');
  assert.equal(read.timeRefs[0]?.value, Date.parse('2027-01-15T08:00:00Z'));
  assert.equal(f.publicCallerReceivedSelection(), false);
  assert.deepEqual(f.counts(), { scans: 0, gets: 2, returned: 1, invocations: 1 });
  assert.deepEqual(await f.tasks.get(f.taskId), f.original);
  // The query selection expires with this owner operation.
  assert.equal((await f.host.list({ kind: 'work' })).length, 601);
});
test('the original authenticated callback returns current public dates without a global scan', async (t) => {
  const f = await fixture();
  const registry = new InvocationRegistry();
  const credentials = await registry.create('owner', 'codex-sol', 'owner-thread');
  const app = Fastify();
  t.after(() => app.close());
  registerEntrustedWorkReadRoutes(app, { service: f.service, callbackRegistry: registry });
  const request = () =>
    app.inject({
      method: 'POST',
      url: '/api/callbacks/read-entrusted-work',
      headers: { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken },
      payload: { taskId: f.taskId },
    });
  const first = await request();
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().ownerRead.publicTime.time.businessDeadline.value, '2027-01-15T08:00:00Z');
  f.setDate('2027-01-16T08:00:00Z');
  const second = await request();
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().ownerRead.publicTime.time.businessDeadline.value, '2027-01-16T08:00:00Z');
  assert.equal(f.counts().scans, 0);
  assert.deepEqual(await f.tasks.get(f.taskId), f.original);
});
test('Schedule keeps its full request-local calendar collection and does not inherit a detail selection', async () => {
  const f = await fixture();
  await f.service.read({ taskId: f.taskId, viewer: { surface: 'human', userId: 'owner' } });
  await f.service.readForOwner('owner');
  assert.deepEqual(f.counts(), { scans: 2, gets: 2, returned: 122, invocations: 2 });
});
test('a Task reassigned during calendar lookup is filtered by the existing owner projection', async () => {
  const f = await fixture();
  const get = f.tasks.get.bind(f.tasks);
  f.beforeRead(async () => {
    f.tasks.get = (id) => {
      const task = get(id);
      return task && id === f.taskId ? { ...task, userId: 'other-owner' } : task;
    };
  });
  await f.service.read({ taskId: f.taskId, viewer: { surface: 'human', userId: 'owner' } });
  assert.deepEqual(f.counts(), { scans: 0, gets: 2, returned: 0, invocations: 1 });
});
test('selected reads still honor thread and kind filters', async () => {
  const f = await fixture();
  f.beforeRead(async () => {
    assert.deepEqual(await f.host.list({ threadId: 'unrelated', kind: 'work' }), []);
    assert.deepEqual(await f.host.list({ kind: 'pr_tracking' }), []);
  });
  await f.service.read({ taskId: f.taskId, viewer: { surface: 'human', userId: 'owner' } });
  assert.equal(f.counts().scans, 0);
  assert.deepEqual(f.selections(), [[f.taskId]]);
});
test('overlapping detail reads keep separate Task selections', async () => {
  const f = await fixture();
  const other = await f.tasks.create({
    threadId: 'another',
    userId: 'owner',
    createdBy: 'user',
    title: 'Second',
    why: 'Concurrent',
  });
  let entered = 0,
    release = () => {};
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  f.beforeRead(async () => {
    if (++entered === 2) release();
    await barrier;
  });
  await Promise.all([f.calendar.read(f.original), f.calendar.read(other)]);
  assert.deepEqual(
    f
      .selections()
      .map((ids) => ids.join(','))
      .sort(),
    [f.taskId, other.id].sort(),
  );
  assert.equal(f.counts().scans, 0);
});
test('retaining a completed operation cannot revive its Task selection', async () => {
  const f = await fixture();
  let captured;
  f.beforeRead(async () => {
    captured = currentOwnerOperation(instanceId);
  });
  await f.service.read({ taskId: f.taskId, viewer: { surface: 'human', userId: 'owner' } });
  assert.ok(captured);
  await assert.rejects(
    withCurrentOwnerOperation(captured, () => f.host.list({ kind: 'work' })),
    /expired/i,
  );
  assert.deepEqual(f.counts(), { scans: 0, gets: 2, returned: 1, invocations: 1 });
});

test('Task projection checkpoints use local lifetime fences without repeated inventory reads', async () => {
  const f = await fixture();
  f.beforeRead(async () => {
    // The installed Collective also rereads this Task after checking its Work authority.
    assert.equal((await f.host.get({ id: f.taskId }))?.id, f.taskId);
  });
  await f.service.read({ taskId: f.taskId, viewer: { surface: 'human', userId: 'owner' } });
  assert.deepEqual(f.selections(), [[f.taskId]]);
  assert.equal(f.inventoryFenceCount(), 1, 'keep the original carrier admission, not sixteen extra inventory IPCs');
});

test('a Task selection cannot narrow another installed instance', async () => {
  const f = await fixture();
  const other = createPluginTaskHost({
    pluginId,
    pluginInstanceId: 'other-calendar-instance',
    ownerUserId: 'owner',
    taskStore: f.tasks,
  });
  f.beforeRead(async () => {
    assert.equal((await other.list({ kind: 'work' })).length, 121);
  });
  await f.service.read({ taskId: f.taskId, viewer: { surface: 'human', userId: 'owner' } });
  assert.deepEqual(f.selections(), [[f.taskId]]);
  assert.equal((await other.list({ kind: 'work' })).length, 121);
});
