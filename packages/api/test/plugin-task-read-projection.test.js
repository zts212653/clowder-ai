import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withPluginCallContext } from '../dist/domains/plugin/carrier/plugin-call-context.js';
import { createPluginTaskHost } from '../dist/domains/plugin/host-surface/task/plugin-task-host.js';

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
    effectiveGrants: ['task.read'],
    taskStore: store,
    ...options,
  });
}

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

test('task read grant and caller lifetime are checked before releasing projected data', async () => {
  for (const [method, arg, storeMethod] of reads) {
    await assert.rejects(() => fixture(minimal, { effectiveGrants: [] })[method](arg), /lacks task.read/);
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
