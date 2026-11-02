import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import '../helpers/setup-cat-registry.js';
import { transitionEntrustedTaskDataController } from '../../src/domains/cats/services/stores/ports/TaskDataControllerTransition.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { hydrateTask, serializeTask } from '../../src/domains/cats/services/stores/redis/RedisTaskCodec.js';

const owner = {
  userId: 'owner',
  catId: 'codex-sol',
  threadId: 'thread-private',
  subjectKey: 'entrusted:legacy-collective-work',
  firstSourceRef: 'message:collective-source',
  admissionAuthorityRef: 'message:host-admission',
};

const controller = {
  pluginId: 'official.collective-connector',
  pluginInstanceId: 'pi-current',
  moduleRef: 'plugin:official.collective-connector',
  lifecycleRevision: 8,
};

const operation = {
  actorRef: 'user:owner',
  operationKey: 'work',
  actionId: 'adopt',
  requestId: 'request-bind-1',
  confirmedAt: 1_792_573_400_000,
};

function fixture() {
  const store = new TaskStore();
  const admitted = store.admitEntrustedWork({
    subjectKey: owner.subjectKey,
    task: {
      threadId: owner.threadId,
      userId: owner.userId,
      ownerCatId: owner.catId,
      createdBy: 'user',
      title: 'Original Collective work',
      why: 'Keep the original Work and result history',
    },
    entrustedWork: {
      revision: 1,
      admission: {
        basis: 'authorized_source',
        sourceRefs: [owner.firstSourceRef],
        idempotencyKey: 'original-admission',
        receiptRef: 'task:receipt:original-admission',
        admittedAt: 100,
        authorityRef: owner.admissionAuthorityRef,
      },
      intendedOutcome: 'Continue the original Work',
      time: { businessDeadline: { value: 1_900_000_000_000, sourceRef: owner.firstSourceRef } },
      progress: { summary: 'Original progress', sourceRef: owner.firstSourceRef },
      artifactRefs: ['artifact:original'],
      closure: {
        state: 'open',
        condition: 'The original owner accepts the result',
        expectedSignal: 'collective:accepted-result',
        evidenceRefs: ['evidence:original'],
      },
    },
  }).task;
  return { store, admitted };
}

function bind(taskId: string, expectedTaskRevision = 1) {
  return {
    action: 'bind' as const,
    taskId,
    expectedTaskRevision,
    operationId: 'owner-operation:bind-original-task',
    expected: owner,
    controller,
    ownerOperation: operation,
  };
}

test('binding advances only the Task contract and keeps the original identity and history', async () => {
  const { store, admitted } = fixture();
  const before = structuredClone(admitted);
  const result = await store.transitionEntrustedTaskDataController(bind(admitted.id));

  assert.equal(result.kind, 'bound');
  assert.equal(result.task.id, before.id);
  assert.equal(result.task.threadId, before.threadId);
  assert.equal(result.task.subjectKey, before.subjectKey);
  assert.equal(result.task.ownerCatId, before.ownerCatId);
  assert.equal(result.task.status, before.status);
  assert.equal(result.task.createdAt, before.createdAt);
  assert.equal(result.task.createdBy, before.createdBy);
  assert.deepEqual(result.task.entrustedWork?.admission, before.entrustedWork?.admission);
  assert.deepEqual(result.task.entrustedWork?.time, before.entrustedWork?.time);
  assert.deepEqual(result.task.entrustedWork?.progress, before.entrustedWork?.progress);
  assert.deepEqual(result.task.entrustedWork?.artifactRefs, before.entrustedWork?.artifactRefs);
  assert.deepEqual(result.task.entrustedWork?.closure, before.entrustedWork?.closure);
  assert.equal(result.task.entrustedWork?.revision, 2);
  assert.equal(result.receipt.confirmedAt, operation.confirmedAt);
  assert.deepEqual(result.task.entrustedWork?.dataController, {
    bindingRevision: 1,
    state: 'active',
    binding: { ...owner, ...controller, ownerOperationReceiptRef: result.receipt.receiptRef },
    receipts: [result.receipt],
  });
});

test('same operation and payload replays the original receipt without another write', async () => {
  const { store, admitted } = fixture();
  const first = await store.transitionEntrustedTaskDataController(bind(admitted.id));
  assert.equal(first.kind, 'bound');
  const beforeReplay = structuredClone(store.get(admitted.id));

  const replay = await store.transitionEntrustedTaskDataController({
    ...bind(admitted.id),
    ownerOperation: { ...operation, requestId: 'request-bind-retry' },
  });

  assert.equal(replay.kind, 'replayed');
  assert.deepEqual(replay.receipt, first.receipt);
  assert.deepEqual(store.get(admitted.id), beforeReplay);

  const closed = store.closeEntrustedWork(admitted.id, {
    expectedRevision: 2,
    closure: {
      state: 'satisfied',
      condition: 'The original owner accepts the result',
      expectedSignal: 'collective:accepted-result',
      evidenceRefs: ['artifact:accepted-after-bind'],
    },
  });
  assert.equal(closed.kind, 'closed');
  const beforeClosedReplay = structuredClone(store.get(admitted.id));
  const closedReplay = await store.transitionEntrustedTaskDataController(bind(admitted.id));
  assert.equal(closedReplay.kind, 'replayed');
  assert.deepEqual(closedReplay.receipt, first.receipt);
  assert.deepEqual(store.get(admitted.id), beforeClosedReplay);
});

test('stale, conflicting, and competing binds leave the complete Task byte-for-byte unchanged', async () => {
  const { store, admitted } = fixture();
  const first = await store.transitionEntrustedTaskDataController(bind(admitted.id));
  assert.equal(first.kind, 'bound');

  for (const command of [
    { ...bind(admitted.id), operationId: 'owner-operation:stale', expectedTaskRevision: 1 },
    {
      ...bind(admitted.id, 2),
      controller: { ...controller, pluginInstanceId: 'pi-forged' },
    },
    {
      ...bind(admitted.id, 2),
      operationId: 'owner-operation:competing',
      controller: {
        ...controller,
        pluginId: 'another.plugin',
        pluginInstanceId: 'pi-other',
        moduleRef: 'plugin:another.plugin',
      },
    },
    {
      ...bind(admitted.id, 2),
      operationId: 'owner-operation:wrong-owner',
      expected: { ...owner, threadId: 'thread-foreign' },
    },
  ]) {
    const before = structuredClone(store.get(admitted.id));
    const result = await store.transitionEntrustedTaskDataController(command);
    assert.ok(
      ['revision_conflict', 'operation_conflict', 'controller_conflict', 'snapshot_conflict'].includes(result.kind),
    );
    assert.deepEqual(store.get(admitted.id), before);
  }
});

test('a confirmed current installation can replace the same module binding from a retired instance', async () => {
  const { store, admitted } = fixture();
  const first = await store.transitionEntrustedTaskDataController(bind(admitted.id));
  assert.equal(first.kind, 'bound');
  const nextController = { ...controller, pluginInstanceId: 'pi-reinstalled', lifecycleRevision: 1 };
  const rebound = await store.transitionEntrustedTaskDataController({
    ...bind(admitted.id, 2),
    operationId: 'owner-operation:adopt-reinstalled-instance',
    controller: nextController,
  });
  assert.equal(rebound.kind, 'bound');
  assert.equal(rebound.task.entrustedWork?.dataController?.bindingRevision, 2);
  assert.equal(rebound.task.entrustedWork?.dataController?.binding.pluginInstanceId, 'pi-reinstalled');
  assert.equal(rebound.task.entrustedWork?.dataController?.receipts[0]?.receiptRef, first.receipt.receiptRef);
});

test('revoke is atomic, old bind replay cannot resurrect it, and a new confirmed bind can rebind', async () => {
  const { store, admitted } = fixture();
  const first = await store.transitionEntrustedTaskDataController(bind(admitted.id));
  assert.equal(first.kind, 'bound');

  const revoked = await store.transitionEntrustedTaskDataController({
    action: 'revoke',
    taskId: admitted.id,
    expectedTaskRevision: 2,
    expectedBindingRevision: 1,
    expectedControllerReceiptRef: first.receipt.receiptRef,
    controller,
    operationId: 'owner-operation:revoke-original-task',
    ownerOperation: { ...operation, actionId: 'revoke', requestId: 'request-revoke-1' },
  });
  assert.equal(revoked.kind, 'revoked');
  assert.equal(revoked.task.entrustedWork?.revision, 3);
  assert.equal(revoked.task.entrustedWork?.dataController?.bindingRevision, 2);
  assert.equal(revoked.task.entrustedWork?.dataController?.state, 'revoked');
  assert.equal(revoked.task.entrustedWork?.dataController?.receipts.length, 2);

  const beforeOldReplay = structuredClone(store.get(admitted.id));
  const oldReplay = await store.transitionEntrustedTaskDataController({
    ...bind(admitted.id),
    ownerOperation: { ...operation, requestId: 'request-bind-after-revoke' },
  });
  assert.equal(oldReplay.kind, 'replayed');
  assert.equal(oldReplay.task.entrustedWork?.dataController?.state, 'revoked');
  assert.deepEqual(store.get(admitted.id), beforeOldReplay);

  const rebound = await store.transitionEntrustedTaskDataController({
    ...bind(admitted.id, 3),
    operationId: 'owner-operation:rebind-original-task',
    ownerOperation: { ...operation, requestId: 'request-rebind-1' },
  });
  assert.equal(rebound.kind, 'bound');
  assert.equal(rebound.task.entrustedWork?.revision, 4);
  assert.equal(rebound.task.entrustedWork?.dataController?.bindingRevision, 3);
  assert.equal(rebound.task.entrustedWork?.dataController?.state, 'active');
  assert.equal(rebound.task.entrustedWork?.dataController?.receipts.length, 3);
  assert.equal(rebound.task.entrustedWork?.dataController?.receipts[0]?.receiptRef, first.receipt.receiptRef);
});

test('closed, generic, and missing Tasks refuse without creating or rewriting anything', async () => {
  const { store, admitted } = fixture();
  const generic = store.create({
    threadId: owner.threadId,
    userId: owner.userId,
    ownerCatId: owner.catId,
    createdBy: 'user',
    title: 'Generic',
    why: '',
  });
  const closed = store.closeEntrustedWork(admitted.id, {
    expectedRevision: 1,
    closure: {
      state: 'satisfied',
      condition: 'The original owner accepts the result',
      expectedSignal: 'collective:accepted-result',
      evidenceRefs: ['artifact:accepted'],
    },
  });
  assert.equal(closed.kind, 'closed');

  for (const [taskId, expectedKind] of [
    [admitted.id, 'closed'],
    [generic.id, 'not_entrusted'],
    ['missing', 'not_found'],
  ] as const) {
    const before = structuredClone(store.listByThread(owner.threadId));
    const result = await store.transitionEntrustedTaskDataController(bind(taskId));
    assert.equal(result.kind, expectedKind);
    assert.deepEqual(store.listByThread(owner.threadId), before);
  }
});

// Captured from the parent f0056865 transition/codec, not regenerated with the new digest algorithm.
function legacyControllerFixture(active = false) {
  const { admitted } = fixture();
  const history = JSON.parse(
    readFileSync(new URL('../fixtures/growing/task-controller-legacy-history.json', import.meta.url), 'utf8'),
  );
  if (active) {
    history.bindingRevision = 1;
    history.state = 'active';
    history.receipts = history.receipts.slice(0, 1);
    delete history.revocationReceiptRef;
  }
  return {
    originalReceipts: history.receipts,
    task: hydrateTask({
      ...serializeTask(admitted),
      id: 'legacy-controller-task',
      entrustedWork: JSON.stringify({
        ...admitted.entrustedWork,
        revision: history.bindingRevision + 1,
        dataController: history,
      }),
    }),
  };
}

test('legacy controller receipt JSON survives reads and subsequent canonical Task writes unchanged', () => {
  const { task, originalReceipts } = legacyControllerFixture();
  assert.equal(JSON.stringify(task.entrustedWork?.dataController?.receipts), JSON.stringify(originalReceipts));
  const persisted = hydrateTask(serializeTask(task));
  assert.equal(JSON.stringify(persisted.entrustedWork?.dataController?.receipts), JSON.stringify(originalReceipts));
  assert.ok(persisted.entrustedWork?.dataController);
  assert.equal('grantRevision' in persisted.entrustedWork.dataController.binding, false);

  const next = transitionEntrustedTaskDataController(task, {
    ...bind(task.id, 3),
    operationId: 'owner-operation:new-bind',
  });
  assert.equal(next.kind, 'bound');
  if (next.kind !== 'bound') return;
  assert.equal(
    JSON.stringify(next.task.entrustedWork?.dataController?.receipts.slice(0, 2)),
    JSON.stringify(originalReceipts),
  );
  assert.ok(next.receipt.kind === 'bind');
  assert.equal('grantRevision' in next.receipt.controller, false);
});

test('legacy bind and revoke retry through current controller coordinates without rewriting receipts or state', () => {
  for (const active of [true, false]) {
    const { task, originalReceipts } = legacyControllerFixture(active);
    const before = JSON.stringify(task);
    const replay = transitionEntrustedTaskDataController(task, {
      ...bind(task.id),
      ownerOperation: { ...operation, requestId: 'new-retry', confirmedAt: operation.confirmedAt + 100 },
    });
    assert.equal(replay.kind, 'replayed');
    if (replay.kind === 'replayed') assert.equal(JSON.stringify(replay.receipt), JSON.stringify(originalReceipts[0]));
    if (!active) {
      const revoke = transitionEntrustedTaskDataController(task, {
        action: 'revoke',
        taskId: task.id,
        expectedTaskRevision: 2,
        operationId: 'owner-operation:revoke-original-task',
        expectedBindingRevision: 1,
        expectedControllerReceiptRef: originalReceipts[0].receiptRef,
        controller,
        ownerOperation: { ...operation, actionId: 'release', requestId: 'retry-revoke' },
      });
      assert.equal(revoke.kind, 'replayed');
      if (revoke.kind === 'replayed') assert.equal(JSON.stringify(revoke.receipt), JSON.stringify(originalReceipts[1]));
      assert.equal(task.entrustedWork?.dataController?.state, 'revoked');
    }
    assert.equal(JSON.stringify(task), before);
  }
});

test('legacy operation IDs still reject changed business payloads and caller/controller coordinates', () => {
  const { task, originalReceipts } = legacyControllerFixture();
  const before = JSON.stringify(task);
  for (const input of [
    { ...bind(task.id), expected: { ...owner, threadId: 'different-thread' } },
    { ...bind(task.id), controller: { ...controller, pluginInstanceId: 'different-instance' } },
    { ...bind(task.id), controller: { ...controller, lifecycleRevision: 9 } },
    { ...bind(task.id), ownerOperation: { ...operation, actorRef: 'user:other-owner' } },
    { ...bind(task.id), ownerOperation: { ...operation, actionId: 'different-action' } },
    {
      action: 'revoke' as const,
      taskId: task.id,
      expectedTaskRevision: 2,
      operationId: 'owner-operation:revoke-original-task',
      expectedBindingRevision: 2,
      expectedControllerReceiptRef: originalReceipts[0].receiptRef,
      controller,
      ownerOperation: { ...operation, actionId: 'release' },
    },
  ]) {
    assert.equal(transitionEntrustedTaskDataController(task, input).kind, 'operation_conflict');
    assert.equal(JSON.stringify(task), before);
  }
});
