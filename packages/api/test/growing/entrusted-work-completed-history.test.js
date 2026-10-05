import assert from 'node:assert/strict';
import { test } from 'node:test';
import '../helpers/setup-cat-registry.js';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { EntrustedWorkLifecycleService } = await import('../../dist/domains/growing/EntrustedWorkLifecycleService.js');
const { EntrustedWorkOwnerReadService } = await import('../../dist/domains/growing/EntrustedWorkOwnerReadService.js');

const originalArtifact = {
  artifactRef: '/uploads/calendar.md',
  artifactRevision: '700',
  completenessRef: 'message:publication#available:700',
  previewRef: 'message:publication#preview:700',
  openInWorkspaceRef: 'workspace:artifact:thread-calendar:700:/uploads/calendar.md',
};
const closure = {
  condition: 'Calendar delivered',
  expectedSignal: 'calendar:accepted',
  state: 'satisfied',
  evidenceRefs: ['message:accepted'],
};

async function fixture({ withReader = true } = {}) {
  const store = new TaskStore();
  let currentArtifact = originalArtifact;
  const artifactReader = {
    async readPreparedArtifact() {
      return currentArtifact;
    },
  };
  const lifecycle = new EntrustedWorkLifecycleService(store, withReader ? { artifactReader } : {});
  const admitted = await lifecycle.admitOrResume({
    task: {
      threadId: 'thread-calendar',
      title: '工作日历',
      why: 'source',
      ownerCatId: 'codex-sol',
      createdBy: 'codex-sol',
      userId: 'owner-calendar',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:calendar'],
      intendedOutcome: 'A usable calendar',
      idempotencyKey: 'calendar',
    },
    closure: { condition: closure.condition, expectedSignal: closure.expectedSignal },
    artifactRefs: [originalArtifact.artifactRef],
  });
  const taskId = admitted.ownerRef.slice('task:item:'.length);
  const reader = new EntrustedWorkOwnerReadService({
    tasks: store,
    artifactReader,
    producerCatalog: {
      async listCurrentReceipts() {
        return [];
      },
    },
  });
  return {
    store,
    lifecycle,
    taskId,
    reader,
    changeArtifact(value) {
      currentArtifact = value;
    },
  };
}

test('completed work leaves active Schedule but remains readable with its sealed delivery', async () => {
  const { store, lifecycle, taskId, reader } = await fixture();
  const closed = await lifecycle.close({ taskId, expectedRevision: 1, closure });
  assert.deepEqual(await reader.listForOwner('owner-calendar'), []);
  const history = await reader.listForOwner('owner-calendar', 'completed');
  assert.equal(history.length, 1);
  assert.equal(history[0].envelope.subjectRef, `task:work:${taskId}`);
  assert.equal(history[0].brief.current.state, 'done');
  assert.equal(history[0].brief.nextOwner.kind, 'unknown');
  assert.deepEqual(history[0].attentionReceipts, []);
  assert.deepEqual(history[0].preparedArtifact, originalArtifact);
  assert.deepEqual(closed.entrustedWork.completion.artifactSnapshot, originalArtifact);
  assert.equal(typeof history[0].completion.recordedAt, 'number');
  assert.deepEqual(history[0].completion.evidenceRefs, closure.evidenceRefs);
  assert.equal(store.get(taskId).entrustedWork.revision, 2);
  await assert.rejects(
    reader.read({ taskId, viewer: { surface: 'human', userId: 'owner-calendar' } }),
    (error) => error.code === 'OWNER_READ_TERMINAL',
  );
  const catRead = await reader.read({
    taskId,
    includeCompleted: true,
    viewer: { surface: 'cat', userId: 'owner-calendar', threadId: 'thread-calendar', catId: 'codex-sol' },
  });
  assert.deepEqual(catRead, history[0]);
  assert.deepEqual(await reader.listForOwner('other-owner', 'completed'), []);
  await assert.rejects(
    reader.read({
      taskId,
      includeCompleted: true,
      viewer: { surface: 'cat', userId: 'owner-calendar', threadId: 'other-thread', catId: 'codex-sol' },
    }),
    (error) => error.code === 'OWNER_READ_FORBIDDEN',
  );
});

test('same ref republished after completion cannot replace the old delivery or create attention', async () => {
  const { lifecycle, taskId, reader, changeArtifact } = await fixture();
  await lifecycle.close({ taskId, expectedRevision: 1, closure });
  changeArtifact({
    ...originalArtifact,
    artifactRevision: '900',
    completenessRef: 'message:republished#available:900',
  });
  const [history] = await reader.listForOwner('owner-calendar', 'completed');
  assert.equal(history.preparedArtifact, undefined);
  assert.equal(history.brief.current.state, 'done');
  assert.deepEqual(history.attentionReceipts, []);
  assert.deepEqual(history.completion.evidenceRefs, closure.evidenceRefs);
});

test('unsealed legacy completion remains discoverable without sampling current material or attention', async () => {
  const { lifecycle, taskId, store } = await fixture({ withReader: false });
  await lifecycle.close({ taskId, expectedRevision: 1, closure });
  const reader = new EntrustedWorkOwnerReadService({
    tasks: store,
    artifactReader: {
      async readPreparedArtifact() {
        throw new Error('must not resample');
      },
    },
    producerCatalog: {
      async listCurrentReceipts() {
        throw new Error('history is not active attention');
      },
    },
  });
  const [history] = await reader.listForOwner('owner-calendar', 'completed');
  assert.equal(history.work.threadId, 'thread-calendar');
  assert.equal(history.preparedArtifact, undefined);
  assert.deepEqual(
    await reader.read({ taskId, includeCompleted: true, viewer: { surface: 'human', userId: 'owner-calendar' } }),
    history,
  );
});

test('a caller cannot nominate a sealed result or completion timestamp', async () => {
  const { lifecycle, taskId, store } = await fixture();
  await assert.rejects(
    lifecycle.close({
      taskId,
      expectedRevision: 1,
      closure,
      completion: { recordedAt: 1, artifactSnapshot: originalArtifact },
    }),
  );
  assert.equal(store.get(taskId).status, 'todo');
});
