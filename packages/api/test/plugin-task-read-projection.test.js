import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeParseExtra, serializeExtra } from '../dist/domains/cats/services/stores/redis/redis-message-parsers.js';
import { withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { createPluginTaskHost } from '../dist/domains/plugin/host-surface/task/plugin-task-host.js';

const currentSdkEntry = import.meta.resolve('@clowder-ai/plugin-sdk');
const { projectTaskReadList: projectCurrentTaskReadList } = await import(new URL('./task-read.js', currentSdkEntry));

const minimal = {
  id: 'task',
  kind: 'work',
  threadId: 'thread',
  subjectKey: 'subject',
  title: 'Work',
  ownerCatId: 'cat',
  status: 'doing',
  why: 'original request',
  createdBy: 'user',
  createdAt: 1,
  updatedAt: 2,
};
const reads = [
  ['get', { id: 'task' }, 'get'],
  ['list', { threadId: 'thread' }, 'listByThread'],
  ['list', { kind: 'work' }, 'listByKind'],
  ['get', { subjectKey: 'subject' }, 'getBySubject'],
];
function fixture(task, options = {}) {
  const store = Object.fromEntries(
    reads.map(([, , method]) => [method, async () => (method.startsWith('list') ? [task] : task)]),
  );
  return createPluginTaskHost({
    pluginInstanceId: 'instance',
    pluginId: 'neutral',
    ownerUserId: 'owner',
    readThreadStore: { get: async (id) => ({ id, createdBy: 'owner' }) },
    taskStore: store,
    ...options,
  });
}

function controlledTask(receiptGrantRevision) {
  const receiptRef = `task-data-controller:${'a'.repeat(64)}`;
  const controllerCoordinates = {
    userId: 'owner',
    catId: 'cat',
    threadId: 'thread',
    subjectKey: 'subject',
    firstSourceRef: 'message:source',
    admissionAuthorityRef: 'message:authority',
    pluginId: 'neutral',
    pluginInstanceId: 'instance',
    moduleRef: 'plugin:neutral',
    lifecycleRevision: 13,
  };
  const receiptController = {
    ...controllerCoordinates,
    ...(receiptGrantRevision === undefined ? {} : { grantRevision: receiptGrantRevision }),
  };
  return {
    ...minimal,
    userId: 'owner',
    entrustedWork: {
      revision: 3,
      artifactRefs: [],
      closure: { state: 'open' },
      admission: {
        basis: 'authorized_source',
        sourceRefs: ['message:source'],
        authorityRef: 'message:authority',
      },
      dataController: {
        bindingRevision: 1,
        state: 'active',
        binding: { ...controllerCoordinates, ownerOperationReceiptRef: receiptRef },
        receipts: [
          {
            receiptRef,
            operationId: 'bind-controller',
            payloadDigest: `sha256:${'b'.repeat(64)}`,
            actorRef: 'user:owner',
            operationKey: 'work',
            actionId: 'adopt-task',
            requestId: 'request',
            confirmedAt: 1,
            recordedAt: 1,
            kind: 'bind',
            controller: receiptController,
          },
        ],
      },
    },
  };
}

test('task reads remain consumable by installed SDK 0.2 beta23 after Host grant cleanup', async () => {
  for (const receiptGrantRevision of [2, undefined]) {
    const task = controlledTask(receiptGrantRevision);
    assert.equal(task.entrustedWork.dataController.binding.grantRevision, undefined);
    const projected = await fixture(task).list({ kind: 'work' });
    assert.equal(projected[0].entrustedWork.dataController.binding.grantRevision, receiptGrantRevision ?? 1);
    assert.equal(
      projectCurrentTaskReadList(projected)[0].entrustedWork.dataController.binding.grantRevision,
      undefined,
    );
  }
});

test('all task read slots project owner and minimal entrusted work without authority or mutable store aliases', async () => {
  const task = {
    ...minimal,
    userId: 'owner',
    automationState: { secret: 'automation' },
    entrustedWork: {
      revision: 3,
      artifactRefs: ['/uploads/report.md'],
      closure: { state: 'open', condition: 'private closure' },
      admission: { sourceRefs: ['message:source'], authorityProvenance: { grantRef: 'secret grant' } },
      execution: { secret: 'execution' },
      seal: 'secret seal',
    },
  };
  const expected = {
    ...minimal,
    userId: 'owner',
    entrustedWork: {
      revision: 3,
      artifactRefs: ['/uploads/report.md'],
      closure: { state: 'open' },
      admission: { sourceRefs: ['message:source'] },
    },
  };
  for (const [method, arg] of reads) {
    const result = await fixture(task)[method](arg);
    const item = Array.isArray(result) ? result[0] : result;
    assert.deepEqual(item, expected, method);
    assert.ok(Object.isFrozen(item.entrustedWork.admission.sourceRefs));
    assert.ok(Object.isFrozen(item.entrustedWork.artifactRefs));
    assert.notEqual(item.entrustedWork.artifactRefs, task.entrustedWork.artifactRefs);
    assert.notEqual(item.entrustedWork.admission.sourceRefs, task.entrustedWork.admission.sourceRefs);
  }
});

test('all task read slots expose only a verified old Host admission coordinate for legacy continuation', async () => {
  const task = {
    ...minimal,
    userId: 'owner',
    entrustedWork: {
      revision: 3,
      artifactRefs: [],
      closure: { state: 'open' },
      admission: {
        basis: 'authorized_source',
        sourceRefs: ['message:source'],
        authorityRef: 'message:host-receipt',
      },
    },
  };
  const receipt = {
    id: 'host-receipt',
    userId: 'owner',
    threadId: 'thread',
    catId: null,
    from: { kind: 'user', userId: 'owner' },
    content: 'Host admission receipt',
    mentions: [],
    timestamp: 1,
    extra: {
      collectiveOwnerAdmissionV1: {
        v: 1,
        sourceRef: 'message:source',
        catId: 'cat',
        ownerAuthProvenance: 'strict',
      },
    },
  };
  const admission = {
    messageStore: {
      getById: async (id) =>
        id === receipt.id
          ? { ...structuredClone(receipt), extra: safeParseExtra(serializeExtra(receipt.extra)) }
          : undefined,
    },
    isCatAvailable: () => true,
    assertCurrent: async () => {},
    readCurrentDataControllerAuthority: async () => undefined,
    withCurrentDataControllerAuthority: async () => {
      throw new Error('unused');
    },
  };
  for (const [method, arg] of reads) {
    const result = await fixture(task, { admission })[method](arg);
    const item = Array.isArray(result) ? result[0] : result;
    assert.deepEqual(item.entrustedWork.admission, {
      sourceRefs: ['message:source'],
      authorityRef: 'message:host-receipt',
      hostReceipt: {
        receiptRef: 'message:host-receipt',
        sourceRef: 'message:source',
        catId: 'cat',
      },
    });
  }
  receipt.extra.collectiveOwnerAdmissionV1.sourceRef = 'message:another-source';
  const rejected = await fixture(task, { admission }).get({ id: task.id });
  assert.equal(rejected.entrustedWork.admission.hostReceipt, undefined);
  receipt.extra.collectiveOwnerAdmissionV1.sourceRef = 'message:source';
  receipt.extra.collectiveAuthorizationInvalid = { reason: 'revoked' };
  const invalidated = await fixture(task, { admission }).get({ id: task.id });
  assert.equal(invalidated.entrustedWork.admission.hostReceipt, undefined);
});

for (const [method, arg, storeMethod] of reads) {
  test(`${method} filters foreign and unverifiable legacy tasks inside Host before projection`, async () => {
    const own = { ...minimal, userId: 'owner' };
    const foreign = { ...minimal, id: 'foreign', userId: 'other', title: 'private title' };
    const legacyOwn = { ...minimal, id: 'legacy-own', threadId: 'own-thread' };
    const legacyForeign = { ...minimal, id: 'legacy-foreign', threadId: 'other-thread' };
    const orphan = { ...minimal, id: 'orphan', threadId: 'missing' };
    const deleted = { ...minimal, id: 'deleted', threadId: 'deleted-thread' };
    const rows = [own, foreign, legacyOwn, legacyForeign, orphan, deleted];
    const options = {
      readThreadStore: {
        get: async (id) =>
          id === 'missing'
            ? null
            : {
                id,
                createdBy: id === 'other-thread' ? 'other' : 'owner',
                ...(id === 'deleted-thread' ? { deletedAt: 1 } : {}),
              },
      },
    };
    if (method.startsWith('list')) {
      const host = fixture(null, { ...options, taskStore: { [storeMethod]: async () => rows } });
      assert.deepEqual(
        (await host[method](arg)).map((t) => t.id),
        ['task', 'legacy-own'],
      );
    } else {
      for (const row of rows) {
        const value = await fixture(row, options)[method](arg);
        assert.equal(value?.id ?? null, ['task', 'legacy-own'].includes(row.id) ? row.id : null);
      }
    }
  });
}

test('missing installation owner fails closed and caller identity cannot substitute it', async () => {
  for (const [method, arg] of reads) {
    await assert.rejects(() => fixture({ ...minimal, userId: 'owner' }, { ownerUserId: undefined })[method](arg));
    await assert.rejects(() =>
      withPluginCallContext(
        'instance',
        {
          userId: 'foreign',
          threadId: 'thread',
          catId: 'cat',
          invocationId: 'inv',
          assertCurrent: async () => {},
        },
        () => fixture({ ...minimal, userId: 'owner' })[method](arg),
      ),
    );
  }
});

test('all read slots withhold legacy tasks if ownership changes during async verification', async () => {
  for (const [method, arg] of reads) {
    let reads = 0;
    const host = fixture(minimal, {
      readThreadStore: { get: async (id) => ({ id, createdBy: ++reads > 1 ? 'foreign' : 'owner' }) },
    });
    await assert.rejects(() => host[method](arg));
    assert.ok(reads >= 2);
  }
});

test('all read slots recheck owner rows and activation after asynchronous work', async () => {
  for (const [method, arg, storeMethod] of reads) {
    let calls = 0;
    const host = fixture(null, {
      taskStore: {
        [storeMethod]: async () => {
          const row = { ...minimal, userId: ++calls > 1 ? 'foreign' : 'owner' };
          return method.startsWith('list') ? [row] : row;
        },
      },
    });
    await assert.rejects(() => host[method](arg), /changed while checking ownership/);
    let active = true;
    const expired = fixture(minimal, {
      readThreadStore: {
        get: async (id) => {
          active = false;
          return { id, createdBy: 'owner' };
        },
      },
      assertCurrent: () => {
        if (!active) throw Error('activation expired');
      },
    });
    await assert.rejects(() => expired[method](arg), /activation expired/);
  }
});

test('all task read slots preserve legacy tasks with an explicit null owner and no invented entrusted work', async () => {
  for (const [method, arg] of reads) {
    const result = await fixture(minimal)[method](arg);
    assert.deepEqual(Array.isArray(result) ? result[0] : result, { ...minimal, userId: null }, method);
  }
  assert.equal(await fixture(null).get({ id: 'missing' }), null);
  assert.equal(await fixture(null).get({ subjectKey: 'missing' }), null);
});

test('task read wait projection removes identities, registration and every nested private extension', async () => {
  const wait = {
    pluginInstanceId: 'instance',
    generation: 2,
    userId: 'owner',
    catId: 'cat',
    threadId: 'thread',
    invalidated: 'owner_changed',
    registration: { invocationId: 'secret-inv', source: { sourceMessageId: 'secret-source' } },
    await: { generation: 2, expiresAt: 9000, secret: 'await-secret' },
    waitOutcome: {
      outcomeId: 'outcome',
      generation: 1,
      ownerFence: { kind: 'containing_task', generation: 1, secret: 'fence-secret' },
      reason: 'matched',
      delivery: 'pending',
      secret: 'outcome-secret',
    },
  };
  const expected = {
    pluginInstanceId: 'instance',
    generation: 2,
    await: { generation: 2, expiresAt: 9000 },
    waitOutcome: {
      outcomeId: 'outcome',
      generation: 1,
      ownerFence: { kind: 'containing_task', generation: 1 },
      reason: 'matched',
      delivery: 'pending',
    },
  };
  for (const [method, arg] of reads) {
    const result = await fixture({ ...minimal, userId: 'owner', pluginWait: wait })[method](arg);
    const item = Array.isArray(result) ? result[0] : result;
    assert.deepEqual(item.pluginWait, expected);
    assert.ok(Object.isFrozen(item.pluginWait.waitOutcome.ownerFence));
  }
});

test('caller lifetime are checked before releasing projected data', async () => {
  for (const [method, arg, storeMethod] of reads) {
    let current = true;
    const host = fixture(minimal, {
      taskStore: {
        [storeMethod]: async () => {
          current = false;
          return method.startsWith('list') ? [minimal] : minimal;
        },
      },
    });
    await assert.rejects(
      () =>
        withPluginCallContext(
          'instance',
          {
            userId: 'owner',
            threadId: 'thread',
            catId: 'cat',
            invocationId: 'inv',
            assertCurrent: async () => {
              if (!current) throw Error('expired');
            },
          },
          () => host[method](arg),
        ),
      /expired/,
    );
  }
});
