import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ordinaryTaskExpectation } from '../dist/domains/cats/services/stores/ports/OrdinaryTaskMutation.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';

function fixture() {
  const store = new TaskStore();
  const task = store.create({
    threadId: 'home',
    title: 'Original Task',
    why: 'Preserve WIP',
    ownerCatId: 'codex',
    createdBy: 'codex',
    userId: 'owner-user',
    sourceMessageId: 'original-source',
  });
  return { store, task };
}
test('owner ABA advances assignment, progress updates do not', () => {
  const { store, task } = fixture();
  const b = store.update(task.id, { ownerCatId: 'sonnet' });
  const a = store.update(task.id, { ownerCatId: 'codex' });
  assert.equal(b.ownerRevision, 1);
  assert.equal(a.ownerRevision, 2);
  assert.equal(store.update(task.id, { status: 'doing', why: 'More progress' })?.ownerRevision, 2);
});
test('same assignment concurrent handoffs have one winner and exact source replay is stable', async () => {
  const { store, task } = fixture();
  const first = {
    kind: 'handoff',
    taskId: task.id,
    expected: ordinaryTaskExpectation(task),
    ownerCatId: 'sonnet',
    messageRef: 'message:first',
  };
  const [a, b] = await Promise.all([
    store.mutateOrdinaryTask(first),
    store.mutateOrdinaryTask({ ...first, ownerCatId: 'codex-sol', messageRef: 'message:second' }),
  ]);
  assert.equal(a.kind, 'updated');
  assert.equal(b.kind, 'refused');
  assert.equal((await store.mutateOrdinaryTask(first)).kind, 'replayed');
  assert.equal(store.get(task.id)?.ownerRevision, 1);
  assert.equal(store.get(task.id)?.sourceMessageId, 'original-source');
  assert.equal(store.get(task.id)?.why, 'Preserve WIP');
  assert.equal(store.get(task.id)?.threadId, 'home');
});
test('stale callback cannot write after owner ABA, even with the same cat and home', async () => {
  const { store, task } = fixture();
  const expected = ordinaryTaskExpectation(task);
  store.update(task.id, { ownerCatId: 'sonnet' });
  store.update(task.id, { ownerCatId: 'codex' });
  const result = await store.mutateOrdinaryTask({
    kind: 'update',
    taskId: task.id,
    expected,
    actor: { userId: 'owner-user', catId: 'codex', threadId: 'home', invocationId: 'old-turn' },
    input: { status: 'done' },
  });
  assert.equal(result.kind, 'refused');
  assert.equal(store.get(task.id)?.status, 'todo');
});
test('execution reservation excludes a handoff and a parallel same-cat writer; stale terminal cannot clear it', async () => {
  const { store, task } = fixture();
  const handoff = await store.mutateOrdinaryTask({
    kind: 'handoff',
    taskId: task.id,
    expected: ordinaryTaskExpectation(task),
    ownerCatId: 'codex',
    messageRef: 'message:work',
  });
  assert.equal(handoff.kind, 'updated');
  const before = store.get(task.id);
  const execution = {
    invocationId: 'child',
    parentInvocationId: 'parent',
    catId: 'codex',
    threadId: 'home',
    sourceMessageId: 'work',
  };
  const bind = await store.mutateOrdinaryTask({
    kind: 'bind_execution',
    taskId: task.id,
    expected: ordinaryTaskExpectation(before),
    execution,
  });
  assert.equal(bind.kind, 'updated');
  const running = store.get(task.id);
  const change = await store.mutateOrdinaryTask({
    kind: 'handoff',
    taskId: task.id,
    expected: ordinaryTaskExpectation(running),
    ownerCatId: 'sonnet',
    messageRef: 'message:next',
  });
  assert.equal(change.kind, 'refused');
  const callback = await store.mutateOrdinaryTask({
    kind: 'update',
    taskId: task.id,
    expected: ordinaryTaskExpectation(running),
    actor: { userId: 'owner-user', catId: 'codex', threadId: 'home', invocationId: 'parallel-child' },
    input: { status: 'done' },
  });
  assert.equal(callback.kind, 'refused');
  const terminal = await store.mutateOrdinaryTask({
    kind: 'release_execution',
    taskId: task.id,
    expected: ordinaryTaskExpectation(running),
    execution: { ...execution, invocationId: 'old-child' },
  });
  assert.equal(terminal.kind, 'refused');
  assert.deepEqual(store.get(task.id)?.executionRef, execution);
});
