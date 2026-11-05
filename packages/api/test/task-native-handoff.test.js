import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrdinaryTaskHandoffService } from '../dist/domains/ball-custody/OrdinaryTaskHandoffService.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ordinaryTaskExpectation } from '../dist/domains/cats/services/stores/ports/OrdinaryTaskMutation.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';

async function fixture() {
  const tasks = new TaskStore(),
    messages = new MessageStore(),
    threads = new ThreadStore();
  const turns = new InMemoryTurnExecutionStore();
  const home = await threads.create('task-user', 'Task home', '/fixture');
  const accepted = await messages.append({
    from: { kind: 'user', userId: 'task-user' },
    userId: 'task-user',
    threadId: home.id,
    content: 'Deliver original accepted work',
    mentions: ['codex'],
    timestamp: Date.now(),
  });
  const task = tasks.create({
    threadId: home.id,
    title: 'Deliver original work',
    why: 'Original WIP',
    ownerCatId: 'codex',
    createdBy: 'codex',
    userId: 'task-user',
    sourceMessageId: accepted.id,
  });
  const deps = { tasks, messages, threads, turns };
  const service = new OrdinaryTaskHandoffService(deps);
  const input = {
    taskId: task.id,
    expectedOwnerRevision: 0,
    actor: { userId: 'task-user', catId: 'codex', threadId: home.id, invocationId: 'issuer' },
    targetCatId: 'sonnet',
    targetThreadId: home.id,
  };
  const append = async (request) =>
    messages.append({
      from: { kind: 'agent', catId: request.issuer.catId },
      userId: request.issuer.userId,
      threadId: request.targetThreadId,
      content: 'Continue original work',
      mentions: [request.targetCatId],
      origin: 'callback',
      timestamp: Date.now(),
      extra: { taskHandoff: request },
    });
  return { ...deps, deps, service, input, task, home, append };
}
test('durable message precedes owner application; restart and source retry reuse one assignment', async () => {
  const f = await fixture();
  const request = await f.service.prepare(f.input);
  assert.equal(f.tasks.get(f.task.id)?.ownerCatId, 'codex');
  const source = await f.append(request);
  const restarted = new OrdinaryTaskHandoffService(f.deps);
  assert.equal((await restarted.apply(source.id)).kind, 'applied');
  assert.equal((await new OrdinaryTaskHandoffService(f.deps).apply(source.id)).kind, 'replayed');
  assert.equal(f.tasks.get(f.task.id)?.ownerRevision, 1);
  assert.equal(f.tasks.get(f.task.id)?.sourceMessageId, f.task.sourceMessageId);
  assert.equal(f.tasks.get(f.task.id)?.threadId, f.home.id);
});
test('same revision requests compete at the Task write and a withdrawn source cannot be applied', async () => {
  const f = await fixture();
  const first = await f.append(await f.service.prepare(f.input));
  const second = await f.append(await f.service.prepare({ ...f.input, targetCatId: 'codex-sol' }));
  const results = await Promise.all([f.service.apply(first.id), f.service.apply(second.id)]);
  assert.deepEqual(results.map((r) => r.kind).sort(), ['applied', 'refused']);
  const g = await fixture();
  const withdrawn = await g.append(await g.service.prepare(g.input));
  await g.messages.softDelete(withdrawn.id, 'task-user');
  assert.deepEqual(await g.service.apply(withdrawn.id), { kind: 'refused', reason: 'task_handoff_source_mismatch' });
  assert.equal(g.tasks.get(g.task.id)?.ownerCatId, 'codex');
});
test('parent terminal or a cancellation receipt cannot substitute for exact child provider teardown', async () => {
  const f = await fixture();
  const initial = await f.append(await f.service.prepare({ ...f.input, targetCatId: 'codex' }));
  await f.service.apply(initial.id);
  const execution = {
    invocationId: 'child',
    parentInvocationId: 'parent',
    catId: 'codex',
    threadId: f.home.id,
    sourceMessageId: initial.id,
  };
  f.turns.createRunning({ ...execution, userId: 'task-user', executionKind: 'ordinary', startedAt: 1 });
  await f.tasks.mutateOrdinaryTask({
    kind: 'bind_execution',
    taskId: f.task.id,
    expected: ordinaryTaskExpectation(f.tasks.get(f.task.id)),
    execution,
  });
  const next = await f.append(await f.service.prepare(f.input));
  assert.equal((await f.service.apply(next.id)).kind, 'waiting');
  f.turns.transitionTerminal('child', { status: 'canceled', endedAt: 2, terminalReason: 'user_cancel' });
  assert.equal((await f.service.apply(next.id)).kind, 'waiting');
  assert.equal(f.tasks.get(f.task.id)?.ownerCatId, 'codex');
});
test('completed actual teardown permits handoff, old terminal cannot release the new writer', async () => {
  const f = await fixture();
  const source = await f.append(await f.service.prepare({ ...f.input, targetCatId: 'codex' }));
  await f.service.apply(source.id);
  const actor = { userId: 'task-user', catId: 'codex', threadId: f.home.id, invocationId: 'first-child' };
  f.turns.createRunning({ ...actor, parentInvocationId: 'first-parent', executionKind: 'ordinary', startedAt: 1 });
  await f.service.start(source.id, actor, 'first-parent');
  const next = await f.append(await f.service.prepare(f.input));
  f.turns.transitionTerminal(actor.invocationId, { status: 'succeeded', endedAt: 2, providerTeardownAt: 2 });
  assert.equal((await f.service.apply(next.id)).kind, 'applied');
  const nextActor = { ...actor, catId: 'sonnet', invocationId: 'second-child' };
  await f.service.start(next.id, nextActor, 'second-parent');
  await f.service.finish(f.task.id, actor.invocationId);
  assert.equal(f.tasks.get(f.task.id)?.executionRef?.invocationId, 'second-child');
});
test('exact approved child stays separate from canonical owner and other proposal pairs fail closed', async () => {
  const f = await fixture();
  const child = await f.threads.create('task-user', 'Approved child', '/fixture');
  const delegates = {
    async getForTask() {
      return [{ catId: 'sonnet', threadId: child.id, evidenceRef: 'approved-exact' }];
    },
  };
  const service = new OrdinaryTaskHandoffService({ ...f.deps, delegates });
  const request = await service.prepare({ ...f.input, targetThreadId: child.id });
  const source = await f.append(request);
  assert.equal((await service.apply(source.id)).kind, 'applied');
  assert.equal(f.tasks.get(f.task.id)?.ownerCatId, 'codex');
  assert.equal(f.tasks.get(f.task.id)?.threadId, f.home.id);
  const unrelated = await f.threads.create('task-user', 'Unapproved child', '/fixture');
  await assert.rejects(
    service.prepare({ ...f.input, targetCatId: 'sonnet', targetThreadId: unrelated.id }),
    /task_approved_contract_unavailable|task_delegate_anchor_missing/,
  );
});
test('restart before provider entry recovers; a started provider without teardown remains unknown', async () => {
  for (const entered of [false, true]) {
    const f = await fixture();
    const source = await f.append(await f.service.prepare({ ...f.input, targetCatId: 'codex' }));
    const actor = { userId: 'task-user', catId: 'codex', threadId: f.home.id, invocationId: 'restart-child' };
    f.turns.createRunning({
      ...actor,
      parentInvocationId: 'restart-parent',
      executionKind: 'ordinary',
      startedAt: 1,
      providerLifecycleTracked: true,
    });
    await f.service.start(source.id, actor, 'restart-parent');
    if (entered) f.turns.markProviderStarted(actor.invocationId, 2);
    f.turns.interruptRunningBefore(10, { endedAt: 10, terminalReason: 'process_restart' });
    const next = await f.append(await f.service.prepare(f.input));
    const restarted = new OrdinaryTaskHandoffService(f.deps);
    assert.equal((await restarted.apply(next.id)).kind, entered ? 'waiting' : 'applied');
  }
});
