import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import './helpers/setup-cat-registry.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import {
  type PluginOwnerOperationContext,
  withCurrentOwnerOperation,
} from '../src/domains/plugin/carrier/plugin-owner-operation-context.js';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import type { PluginTaskAdmissionServices } from '../src/domains/plugin/host-surface/task/plugin-task-data-services.js';
import { createPluginTaskAdmissionServices } from '../src/domains/plugin/host-surface/task/plugin-task-data-services.js';
import { createPluginTaskHost } from '../src/domains/plugin/host-surface/task/plugin-task-host.js';

function pluginTaskDataAuthority(instanceId: string, subjectKey: string): string {
  return `plugin-task-data:${createHash('sha256')
    .update(JSON.stringify([instanceId, subjectKey]))
    .digest('hex')}`;
}

async function fixture({ admissionOwned = false }: { readonly admissionOwned?: boolean } = {}) {
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  const thread = await threads.create('owner', 'Private Work');
  threads.addParticipants(thread.id, ['codex-sol']);
  const subjectKey = 'entrusted:legacy-collective';
  const pluginInstanceId = 'pi-current';
  const admissionAuthorityRef = admissionOwned
    ? pluginTaskDataAuthority(pluginInstanceId, subjectKey)
    : 'message:host-admission';
  const original = tasks.admitEntrustedWork({
    subjectKey,
    task: {
      threadId: thread.id,
      userId: 'owner',
      ownerCatId: 'codex-sol',
      createdBy: 'user',
      title: 'Original Collective work',
      why: 'Preserve its result and history',
    },
    entrustedWork: {
      revision: 1,
      admission: {
        basis: 'authorized_source',
        sourceRefs: ['message:collective-source'],
        idempotencyKey: 'original-admission',
        receiptRef: 'task:receipt:original-admission',
        admittedAt: 100,
        authorityRef: admissionAuthorityRef,
      },
      intendedOutcome: 'Continue the original Work',
      time: {},
      artifactRefs: ['artifact:original'],
      closure: {
        state: 'open',
        condition: 'Owner accepts',
        expectedSignal: 'collective:accepted-result',
        evidenceRefs: [],
      },
    },
  }).task;
  assert.ok(original.subjectKey);
  let current = true;
  const controller = {
    pluginId: 'official.collective-connector',
    pluginInstanceId,
    moduleRef: 'plugin:official.collective-connector',
    lifecycleRevision: 8,
  };
  let controllerAuthority = controller;
  let controllerAuthorityAvailable = true;
  let beforeControllerMutation: (() => void | Promise<void>) | undefined;
  const admission = {
    messageStore: {
      getById: async () => null,
      getByIdempotencyKey: async () => null,
      appendIdempotent: async () => {
        throw new Error('not used');
      },
    },
    isCatAvailable: (catId: string) => catId === 'codex-sol',
    assertCurrent: async () => {
      if (!current) throw new Error('controller fence changed');
    },
    readCurrentDataControllerAuthority: async () =>
      current && controllerAuthorityAvailable ? { ...controllerAuthority } : undefined,
    withCurrentDataControllerAuthority: async <T>(
      run: (authority: typeof controller & { readonly lifecycleRevision: number }) => Promise<T>,
    ) => {
      if (!current || !controllerAuthorityAvailable) throw new Error('controller fence changed');
      await beforeControllerMutation?.();
      return run({
        ...controllerAuthority,
      });
    },
  } as unknown as PluginTaskAdmissionServices;
  const changes: string[] = [];
  const host = createPluginTaskHost({
    pluginId: controller.pluginId,
    pluginInstanceId: controller.pluginInstanceId,
    ownerUserId: 'owner',
    taskStore: tasks,
    threadStore: threads,
    readThreadStore: threads,
    admission,
    assertCurrent: async () => {
      if (!current) throw new Error('activation expired');
    },
    onTaskDataChanged: (task) => changes.push(task.id),
  });
  const bind = {
    taskId: original.id,
    expectedTaskRevision: 1,
    operationId: 'adopt-original-work',
    expected: {
      ownerCatId: 'codex-sol',
      threadId: thread.id,
      subjectKey: original.subjectKey,
      firstSourceRef: 'message:collective-source',
      admissionAuthorityRef,
    },
  };
  const ownerOperation = (confirmed: boolean, actionId = 'adopt'): PluginOwnerOperationContext => ({
    kind: 'owner-operation',
    userId: 'owner',
    pluginInstanceId: controller.pluginInstanceId,
    operationKey: 'work',
    actionId,
    requestId: `request:${actionId}:${confirmed}`,
    confirmed,
    signal: new AbortController().signal,
    assertWriteCurrent: () => {
      if (!current) throw new Error('owner operation expired');
    },
    assertCurrent: async () => {
      if (!current) throw new Error('owner operation expired');
    },
  });
  return {
    tasks,
    threads,
    host,
    original,
    bind,
    admission,
    changes,
    controller,
    ownerOperation,
    expire: () => {
      current = false;
    },
    driftActivation: () => {
      controllerAuthority = { ...controllerAuthority, lifecycleRevision: controllerAuthority.lifecycleRevision + 1 };
    },
    removeControllerAuthority: () => {
      controllerAuthorityAvailable = false;
    },
    beforeControllerMutation: (hook: (() => void | Promise<void>) | undefined) => {
      beforeControllerMutation = hook;
    },
  };
}

test('only a confirmed Host owner operation can bind the exact legacy Task', async () => {
  const f = await fixture();
  const before = structuredClone(f.tasks.get(f.original.id));
  await assert.rejects(f.host.bindDataController(f.bind), /confirmed owner operation/i);
  await assert.rejects(
    withCurrentOwnerOperation(f.ownerOperation(false), () => f.host.bindDataController(f.bind)),
    /confirmed owner operation/i,
  );
  await assert.rejects(
    withCurrentOwnerOperation(f.ownerOperation(true), () =>
      f.host.bindDataController({ ...f.bind, confirmed: true, actorRef: 'user:owner' }),
    ),
    /unrecognized|supported fields/i,
  );
  assert.deepEqual(f.tasks.get(f.original.id), before);

  const bound = await withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind));
  assert.equal(bound.disposition, 'bound');
  assert.equal(bound.task.id, f.original.id);
  assert.equal(bound.task.entrustedWork?.revision, 2);
  assert.equal(bound.task.entrustedWork?.dataController?.state, 'active');
  assert.equal(bound.task.entrustedWork?.dataController?.binding.pluginInstanceId, f.controller.pluginInstanceId);
  assert.equal(f.tasks.listByThread(f.original.threadId).length, 1);
  assert.deepEqual(f.changes, [f.original.id]);
});

test('active binding admits same-Task data updates; confirmed revoke makes later writes fail closed', async () => {
  const f = await fixture({ admissionOwned: true });
  const bound = await withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind));
  assert.ok(bound.task.entrustedWork);
  const updated = await f.host.update(
    f.original.id,
    {
      entrustedWork: {
        expectedRevision: bound.task.entrustedWork.revision,
        progress: { summary: 'Continued by the current module', sourceRef: 'message:collective-source' },
      },
    },
    { expectedThreadId: f.original.threadId },
  );
  assert.equal(updated?.id, f.original.id);
  assert.equal(updated?.entrustedWork?.revision, 3);
  assert.deepEqual(updated?.entrustedWork?.admission, f.original.entrustedWork?.admission);
  assert.ok(updated?.entrustedWork?.dataController);
  const binding = updated.entrustedWork.dataController;
  const revoked = await withCurrentOwnerOperation(f.ownerOperation(true, 'revoke'), () =>
    f.host.revokeDataController({
      taskId: f.original.id,
      expectedTaskRevision: updated.entrustedWork.revision,
      expectedBindingRevision: binding.bindingRevision,
      expectedControllerReceiptRef: binding.binding.ownerOperationReceiptRef,
      operationId: 'revoke-original-work',
    }),
  );
  assert.equal(revoked.disposition, 'revoked');
  assert.equal(revoked.task.entrustedWork?.dataController?.state, 'revoked');
  assert.ok(revoked.task.entrustedWork);
  const beforeRejected = structuredClone(f.tasks.get(f.original.id));
  await assert.rejects(
    f.host.update(f.original.id, {
      entrustedWork: {
        expectedRevision: revoked.task.entrustedWork.revision,
        progress: { summary: 'Must not write', sourceRef: 'message:collective-source' },
      },
    }),
    /controller|installation/i,
  );
  assert.deepEqual(f.tasks.get(f.original.id), beforeRejected);
  assert.deepEqual(f.changes, [f.original.id, f.original.id, f.original.id]);
});

test('admission fallback cannot bypass a controller with moved or foreign coordinates', async () => {
  for (const mismatch of ['thread', 'plugin-instance'] as const) {
    const f = await fixture({ admissionOwned: true });
    const bound = await withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind));
    assert.ok(bound.task.entrustedWork);
    const projected = structuredClone(bound.task);
    if (mismatch === 'thread') {
      const movedThread = await f.threads.create('owner', 'Moved Work');
      f.threads.addParticipants(movedThread.id, ['codex-sol']);
      projected.threadId = movedThread.id;
    } else {
      assert.ok(projected.entrustedWork?.dataController);
      projected.entrustedWork.dataController.binding.pluginInstanceId = 'pi-foreign';
    }
    const before = structuredClone(f.tasks.get(f.original.id));
    const projectedStore = new Proxy(f.tasks, {
      get(target, key, receiver) {
        if (key === 'get') return (taskId: string) => (taskId === projected.id ? structuredClone(projected) : null);
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const host = createPluginTaskHost({
      pluginId: f.controller.pluginId,
      pluginInstanceId: f.controller.pluginInstanceId,
      ownerUserId: 'owner',
      taskStore: projectedStore,
      threadStore: f.threads,
      readThreadStore: f.threads,
      admission: f.admission,
    });
    assert.equal((await host.get({ id: f.original.id }))?.entrustedWork?.dataController?.currentForCaller, false);
    await assert.rejects(
      host.update(f.original.id, {
        entrustedWork: {
          expectedRevision: bound.task.entrustedWork.revision,
          progress: { summary: `Must reject ${mismatch}`, sourceRef: 'message:collective-source' },
        },
      }),
      /controller|installation|contract/i,
    );
    assert.deepEqual(f.tasks.get(f.original.id), before, mismatch);
  }
});

test('lifecycle drift before the controller CAS leaves the Task unchanged', async () => {
  const f = await fixture();
  const before = structuredClone(f.tasks.get(f.original.id));
  f.expire();
  await assert.rejects(
    withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind)),
    /expired|fence|current/i,
  );
  assert.deepEqual(f.tasks.get(f.original.id), before);
  assert.deepEqual(f.changes, []);
});

test('owner-operation expiry at the Task CAS leaves bind, revoke, and update unchanged', async () => {
  for (const action of ['bind', 'revoke', 'update'] as const) {
    const f = await fixture({ admissionOwned: true });
    const bound =
      action !== 'bind'
        ? await withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind))
        : undefined;
    const controller = bound?.task.entrustedWork?.dataController;
    if (action !== 'bind') assert.ok(controller);
    let expired = false;
    f.beforeControllerMutation(() => {
      expired = true;
    });
    const operation: PluginOwnerOperationContext = {
      ...f.ownerOperation(true, action),
      assertWriteCurrent: () => {
        if (expired) throw new Error('owner operation expired');
      },
      assertCurrent: async () => {
        if (expired) throw new Error('owner operation expired');
      },
    };
    const before = structuredClone(f.tasks.get(f.original.id));
    let mutation: () => Promise<unknown>;
    if (action === 'bind') {
      mutation = () => f.host.bindDataController(f.bind);
    } else {
      const boundWork = bound?.task.entrustedWork;
      assert.ok(boundWork);
      assert.ok(controller);
      mutation =
        action === 'revoke'
          ? () =>
              f.host.revokeDataController({
                taskId: f.original.id,
                expectedTaskRevision: boundWork.revision,
                expectedBindingRevision: controller.bindingRevision,
                expectedControllerReceiptRef: controller.binding.ownerOperationReceiptRef,
                operationId: 'revoke-after-owner-expiry',
              })
          : () =>
              f.host.update(f.original.id, {
                entrustedWork: {
                  expectedRevision: boundWork.revision,
                  progress: { summary: 'Must not update after owner expiry', sourceRef: 'message:collective-source' },
                },
              });
    }
    await assert.rejects(withCurrentOwnerOperation(operation, mutation), /expired|current/i, action);
    assert.deepEqual(f.tasks.get(f.original.id), before, action);
  }
});

for (const action of ['update', 'close'] as const) {
  test(`a revoke serialized ahead of ${action} invalidates the captured controller snapshot`, async () => {
    const f = await fixture({ admissionOwned: true });
    const bound = await withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind));
    const controller = bound.task.entrustedWork?.dataController;
    assert.ok(controller);
    let revokedSnapshot: ReturnType<typeof f.tasks.get>;
    f.beforeControllerMutation(async () => {
      const revoked = await f.tasks.transitionEntrustedTaskDataController({
        action: 'revoke',
        taskId: f.original.id,
        expectedTaskRevision: 2,
        expectedBindingRevision: controller.bindingRevision,
        expectedControllerReceiptRef: bound.receiptRef,
        controller: f.controller,
        operationId: `serialized-revoke-before-${action}`,
        ownerOperation: {
          actorRef: 'user:owner',
          operationKey: 'work',
          actionId: 'revoke',
          requestId: `request:serialized-revoke-before-${action}`,
          confirmedAt: Date.now(),
        },
      });
      assert.equal(revoked.kind, 'revoked');
      revokedSnapshot = structuredClone(f.tasks.get(f.original.id));
    });
    const entrustedWork =
      action === 'update'
        ? {
            expectedRevision: 3,
            progress: { summary: 'Must fail after revoke', sourceRef: 'message:collective-source' },
          }
        : {
            expectedRevision: 3,
            closure: {
              state: 'satisfied' as const,
              condition: 'Owner accepts',
              expectedSignal: 'collective:accepted-result',
              evidenceRefs: ['message:collective-source'],
            },
          };
    await assert.rejects(f.host.update(f.original.id, { entrustedWork }), /controller|installation|contract|revision/i);
    assert.deepEqual(f.tasks.get(f.original.id), revokedSnapshot);
  });
}

test('a bind serialized ahead of an admission update supplies the current authorized snapshot', async () => {
  const f = await fixture({ admissionOwned: true });
  f.beforeControllerMutation(async () => {
    const bound = await f.tasks.transitionEntrustedTaskDataController({
      action: 'bind',
      taskId: f.original.id,
      expectedTaskRevision: 1,
      operationId: 'serialized-bind-before-update',
      expected: {
        userId: 'owner',
        catId: f.bind.expected.ownerCatId,
        threadId: f.bind.expected.threadId,
        subjectKey: f.bind.expected.subjectKey,
        firstSourceRef: f.bind.expected.firstSourceRef,
        admissionAuthorityRef: f.bind.expected.admissionAuthorityRef,
      },
      controller: f.controller,
      ownerOperation: {
        actorRef: 'user:owner',
        operationKey: 'work',
        actionId: 'bind',
        requestId: 'request:serialized-bind-before-update',
        confirmedAt: Date.now(),
      },
    });
    assert.equal(bound.kind, 'bound');
  });
  const updated = await f.host.update(f.original.id, {
    entrustedWork: {
      expectedRevision: 2,
      progress: { summary: 'Authorized after bind', sourceRef: 'message:collective-source' },
    },
  });
  assert.equal(updated?.entrustedWork?.revision, 3);
  assert.equal(updated?.entrustedWork?.dataController?.state, 'active');
});

test('owner confirmation cannot bind a Task whose actual owner Thread disappeared', async () => {
  const f = await fixture(),
    before = structuredClone(f.tasks.get(f.original.id));
  f.threads.delete(f.original.threadId);
  await assert.rejects(
    withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind)),
    /thread|participant|current/i,
  );
  assert.deepEqual(f.tasks.get(f.original.id), before);
});

test('a same-instance stale controller is projected as unusable without rewriting its durable history', async () => {
  const f = await fixture({ admissionOwned: true });
  await withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind));
  assert.equal((await f.host.get({ id: f.original.id }))?.entrustedWork?.dataController?.currentForCaller, true);
  f.driftActivation();
  assert.equal((await f.host.get({ id: f.original.id }))?.entrustedWork?.dataController?.currentForCaller, false);
  assert.equal(
    f.tasks.get(f.original.id)?.entrustedWork?.dataController?.state,
    'active',
    'read refusal must not rewrite durable controller history',
  );
  const before = structuredClone(f.tasks.get(f.original.id));
  assert.ok(before?.entrustedWork);
  await assert.rejects(
    f.host.update(f.original.id, {
      entrustedWork: {
        expectedRevision: before.entrustedWork.revision,
        progress: { summary: 'Must reject stale controller', sourceRef: 'message:collective-source' },
      },
    }),
    /controller|current|installation/i,
  );
  assert.deepEqual(f.tasks.get(f.original.id), before);
});

test('a stopped controller installation projects false without turning an otherwise readable Task into an error', async () => {
  const f = await fixture();
  await withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind));
  const before = structuredClone(f.tasks.get(f.original.id));
  f.removeControllerAuthority();
  assert.equal((await f.host.get({ id: f.original.id }))?.entrustedWork?.dataController?.currentForCaller, false);
  assert.deepEqual(f.tasks.get(f.original.id), before);
});

test('a controller cannot maintain a Task whose immutable admission is not an authorized source', async () => {
  const f = await fixture();
  const bound = await withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind));
  const incompatible = structuredClone(bound.task);
  assert.ok(incompatible.entrustedWork);
  incompatible.entrustedWork.admission = {
    basis: 'explicit_entrustment',
    sourceRefs: ['message:collective-source'],
    idempotencyKey: 'original-admission',
    receiptRef: 'task:receipt:original-admission',
    admittedAt: 100,
  };
  const incompatibleStore = new Proxy(f.tasks, {
    get(target, key, receiver) {
      if (key === 'get') return (taskId: string) => (taskId === incompatible.id ? structuredClone(incompatible) : null);
      const value = Reflect.get(target, key, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const host = createPluginTaskHost({
    pluginId: f.controller.pluginId,
    pluginInstanceId: f.controller.pluginInstanceId,
    ownerUserId: 'owner',
    taskStore: incompatibleStore,
    threadStore: f.threads,
    readThreadStore: f.threads,
    admission: f.admission,
  });
  assert.equal((await host.get({ id: incompatible.id }))?.entrustedWork?.dataController?.currentForCaller, false);
  await assert.rejects(
    host.update(incompatible.id, {
      entrustedWork: {
        expectedRevision: incompatible.entrustedWork.revision,
        progress: {
          summary: 'Must not write through an incompatible admission',
          sourceRef: 'message:collective-source',
        },
      },
    }),
    /contract|controller|installation/i,
  );
});

test('a new confirmed bind replaces only a stale same-installation controller and preserves its receipt history', async () => {
  const f = await fixture();
  const first = await withCurrentOwnerOperation(f.ownerOperation(true), () => f.host.bindDataController(f.bind));
  f.driftActivation();
  const rebound = await withCurrentOwnerOperation(f.ownerOperation(true, 'rebind'), () =>
    f.host.bindDataController({ ...f.bind, expectedTaskRevision: 2, operationId: 'rebind-after-activation-change' }),
  );
  assert.equal(rebound.disposition, 'bound');
  assert.equal(rebound.task.entrustedWork?.revision, 3);
  assert.equal(rebound.task.entrustedWork?.dataController?.bindingRevision, 2);
  assert.equal(rebound.task.entrustedWork?.dataController?.binding.lifecycleRevision, 9);
  assert.equal(rebound.task.entrustedWork?.dataController?.currentForCaller, true);
  assert.notEqual(rebound.receiptRef, first.receiptRef);
  assert.equal(f.tasks.get(f.original.id)?.entrustedWork?.dataController?.receipts.length, 2);
});

test('real inventory serialization rejects a activation change committed after confirmation but before Task CAS', async () => {
  const f = await fixture();
  const inventory = new MemoryPluginInventoryStore();
  const control = new HostInventoryControlPlane(inventory, {
    createInstanceId: () => f.controller.pluginInstanceId,
    now: () => 1_000,
  });
  const packageDigest = `sha512-${createHash('sha512').update('collective-controller-race').digest('base64')}`;
  await control.installPackage({
    manifest: {
      pluginId: f.controller.pluginId,
      version: '1.0.0',
      contractVersion: '0.1.0',
      name: 'Collective controller race',
      runtime: { transport: 'builtin' },
      features: [
        { id: 'work', name: 'Work', resources: [], capabilities: ['task.read', 'task.write', 'task.admitEntrusted'] },
      ],
    },
    computedPackageDigest: packageDigest,
    expectedPackageDigest: packageDigest,
    packagePluginId: f.controller.pluginId,
  });
  await inventory.transaction((tx) => {
    const instance = tx.instances.get(f.controller.pluginInstanceId);
    assert.ok(instance);
    tx.instances.put({ ...instance, configReadiness: 'ready', activationState: 'enabled', runtimeState: 'healthy' });
  });
  const admission = await createPluginTaskAdmissionServices({
    pluginInstanceId: f.controller.pluginInstanceId,
    packageDigest,
    inventory,
    messageStore: {
      getById: async () => null,
      getByIdempotencyKey: async () => null,
      appendIdempotent: async () => {
        throw new Error('unused');
      },
    },
    assertActivation: () => {},
    isCatAvailable: (catId) => catId === 'codex-sol',
  });
  const host = createPluginTaskHost({
    pluginId: f.controller.pluginId,
    pluginInstanceId: f.controller.pluginInstanceId,
    ownerUserId: 'owner',
    taskStore: f.tasks,
    threadStore: f.threads,
    readThreadStore: f.threads,
    admission,
  });
  let entered!: () => void, release!: () => void;
  const atConfirmedBoundary = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const continueToInventory = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checks = 0;
  const operation: PluginOwnerOperationContext = {
    ...f.ownerOperation(true),
    assertCurrent: async () => {
      if (checks++ === 0) {
        entered();
        await continueToInventory;
      }
    },
  };
  const before = structuredClone(f.tasks.get(f.original.id));
  const pending = withCurrentOwnerOperation(operation, () => host.bindDataController(f.bind));
  await atConfirmedBoundary;
  await inventory.transaction((tx) => {
    const current = tx.instances.get(f.controller.pluginInstanceId)!;
    tx.instances.put({ ...current, activationState: 'disabled' });
  });
  release();
  await assert.rejects(pending, /controller capability|task.write|current/i);
  assert.deepEqual(f.tasks.get(f.original.id), before);
});
