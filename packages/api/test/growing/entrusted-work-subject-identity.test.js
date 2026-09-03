import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import '../helpers/setup-cat-registry.js';

const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
const { EntrustedWorkLifecycleService } = await import('../../dist/domains/growing/EntrustedWorkLifecycleService.js');

const now = 1_788_232_000_000;

function admissionCommand() {
  return {
    task: {
      threadId: 'thread-source',
      title: 'Prepare the canonical result',
      why: 'Explicitly entrusted in the source conversation',
      createdBy: 'codex-sol',
      ownerCatId: 'codex-sol',
      userId: 'owner-1',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source-1'],
      intendedOutcome: 'A reviewable result is ready',
      idempotencyKey: 'entrusted:subject-identity',
    },
    closure: {
      condition: 'The result is reviewable',
      expectedSignal: 'artifact:final',
    },
  };
}

function genericTask(subjectKey, overrides = {}) {
  return {
    subjectKey,
    threadId: 'thread-shadow',
    title: 'Generic shadow task',
    why: 'Attempt to claim the same fact',
    createdBy: 'codex-terra',
    ownerCatId: 'codex-terra',
    userId: 'owner-1',
    ...overrides,
  };
}

describe('F310 Task subject identity', () => {
  test('generic create and upsert cannot preclaim the entrusted subject namespace', () => {
    const store = new TaskStore();
    const reservedSubject = `entrusted:${'a'.repeat(64)}`;

    assert.throws(
      () => store.create(genericTask(reservedSubject)),
      (error) => error?.code === 'TASK_SUBJECT_NAMESPACE_RESERVED',
    );
    assert.throws(
      () => store.upsertBySubject(genericTask(reservedSubject)),
      (error) => error?.code === 'TASK_SUBJECT_NAMESPACE_RESERVED',
    );
    assert.throws(
      () =>
        store.upsertBySubjectWithManagedWorkBinding(genericTask(reservedSubject, { kind: 'pr_tracking' }), {
          workId: 'work-shadow',
          attemptId: 'attempt-shadow',
        }),
      (error) => error?.code === 'TASK_SUBJECT_NAMESPACE_RESERVED',
    );
    assert.equal(store.getBySubject(reservedSubject), null);
    assert.deepEqual(store.listByThread('thread-shadow'), []);
  });

  test('generic create cannot shadow admitted custody and typed replay keeps the canonical owner', async () => {
    const store = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admitted = await lifecycle.admitOrResume(admissionCommand());
    const taskId = admitted.ownerRef.replace('task:item:', '');
    const canonical = store.get(taskId);

    assert.throws(
      () => store.create(genericTask(canonical.subjectKey)),
      (error) => error?.code === 'TASK_SUBJECT_NAMESPACE_RESERVED',
    );
    assert.equal(store.getBySubject(canonical.subjectKey).id, taskId);
    assert.deepEqual(store.listByThread('thread-shadow'), []);

    const replay = await lifecycle.admitOrResume(admissionCommand());
    assert.equal(replay.result, 'resumed');
    assert.equal(replay.ownerRef, admitted.ownerRef);
    assert.equal(store.listByThread('thread-source').length, 1);
  });

  test('generic full-object updates reject even metadata-only changes to entrusted work', async () => {
    const store = new TaskStore();
    const lifecycle = new EntrustedWorkLifecycleService(store, { now: () => now });
    const admitted = await lifecycle.admitOrResume(admissionCommand());
    const taskId = admitted.ownerRef.replace('task:item:', '');

    for (const mutate of [
      () => store.update(taskId, { title: 'Stale generic title' }),
      () => store.updateIfThreadId(taskId, 'thread-source', { why: 'Stale generic rationale' }),
    ]) {
      assert.throws(mutate, (error) => error?.code === 'ENTRUSTED_WORK_TERMINAL_ACTION_REQUIRED');
    }

    const canonical = store.get(taskId);
    assert.equal(canonical.title, 'Prepare the canonical result');
    assert.equal(canonical.why, 'Explicitly entrusted in the source conversation');
    assert.equal(canonical.status, 'todo');
    assert.equal(canonical.entrustedWork.revision, 1);
  });

  test('ordinary subject creation is unique while upsert preserves the existing Task identity', () => {
    const store = new TaskStore();
    const subjectKey = 'pr:acme/widgets#310';
    const original = store.create(genericTask(subjectKey, { threadId: 'thread-original' }));

    assert.throws(
      () => store.create(genericTask(subjectKey)),
      (error) => error?.code === 'TASK_SUBJECT_ALREADY_EXISTS',
    );
    assert.equal(store.getBySubject(subjectKey).id, original.id);
    assert.deepEqual(store.listByThread('thread-shadow'), []);

    const updated = store.upsertBySubject(
      genericTask(subjectKey, { threadId: 'thread-original', title: 'Updated canonical task' }),
    );
    assert.equal(updated.id, original.id);
    assert.equal(updated.title, 'Updated canonical task');
    assert.equal(store.getBySubject(subjectKey).id, original.id);
  });
});
