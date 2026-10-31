import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ContentModificationCancellationService } from '../src/domains/collaborative-content/modification/control/cancellation-service.js';
import { signEditToken } from '../src/domains/workspace/workspace-edit.js';
import { cancellationFixture as fixture } from './helpers/content-modification-cancellation-fixture.js';

test('the independently bound target reads a content-free cancellation after the human request source is recalled', async (t) => {
  const f = await fixture(t);
  const request = await f.integration.requests.submit(f.payload, f.human);
  await f.cancel();
  const source = f.messages.getById(request.record.progress.sourceMessageId!);
  assert.ok(source);
  source.recall = { recalledAt: Date.now(), recalledBy: 'operator' };
  const response = await f.catRead();
  assert.equal(response.statusCode, 200, response.body);
  const value = JSON.parse(response.json().json);
  assert.equal(value.stage, 'cancelled');
  assert.equal(value.taskId, request.record.progress.task!.taskId);
  assert.equal('intent' in value, false);
  assert.equal('sourceRef' in value, false);
  await assert.rejects(
    f.integration.requests.cancelledForCat(f.requestId, { ...f.cat, actor: { kind: 'cat', actorId: 'opus5' } }),
    /not_found/,
  );
});

test('an unresponsive Task owner cannot keep the cancellation response open or turn unknown into no Task', async (t) => {
  const f = await fixture(t);
  f.store.requests.reserve('operator', f.payload);
  let release!: (value: null) => void;
  f.tasks.getBySubject = async () =>
    new Promise<null>((resolve) => {
      release = resolve;
    });
  const control = new ContentModificationCancellationService({
    store: f.store,
    tasks: f.tasks,
    lifecycle: f.lifecycle,
    onError: (error) => f.errors.push(error),
    attemptBudgetMs: 1500,
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = control.cancel(f.requestId, 'operator').then((view) => {
    settled = true;
    return view;
  });
  await Promise.resolve();
  t.mock.timers.tick(1500);
  for (let index = 0; index < 5; index++) await Promise.resolve();
  assert.equal(settled, true);
  assert.equal((await pending).control?.taskResolution, 'unknown');
  release(null);
  await new Promise((resolve) => setImmediate(resolve));
});

test('a new context cannot attach while this request has fenced its sole Task for human cancellation', async (t) => {
  const f = await fixture(t);
  const first = await f.integration.requests.submit(f.payload, f.human),
    task = first.record.progress.task;
  assert.ok(task);
  const close = f.tasks.closeEntrustedWork.bind(f.tasks);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.tasks.closeEntrustedWork = async (...args) => {
    enter();
    await blocked;
    return close(...args);
  };
  const cancelled = f.cancel();
  await entered;
  await assert.rejects(
    f.integration.requests.submit(
      {
        ...f.payload,
        operationId: randomUUID(),
        taskContext: { kind: 'text', taskId: task.taskId, expectedTaskRevision: task.revision },
      },
      f.human,
    ),
    /task_cancellation_pending/,
  );
  release();
  assert.equal((await cancelled).statusCode, 200);
});

for (const phase of ['before_commit', 'after_commit'] as const)
  test(`cancel during Task admission (${phase}) persists first, discovers the same late Task and never dispatches or admits twice`, async (t) => {
    const f = await fixture(t),
      admit = f.tasks.admitEntrustedWork.bind(f.tasks);
    let enter!: () => void,
      release!: () => void,
      calls = 0;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.tasks.admitEntrustedWork = async (input) => {
      calls += 1;
      if (phase === 'before_commit') {
        enter();
        await blocked;
        return admit(input);
      }
      const result = await admit(input);
      enter();
      await blocked;
      return result;
    };
    const submitting = f.integration.requests.submit(f.payload, f.human);
    await entered;
    const pending = await f.app.inject({
      url: `/api/content-modifications/by-operation/${f.payload.operationId}`,
      headers: { 'x-cat-cafe-user': 'operator' },
    });
    const cancelled = await f.cancel();
    release();
    await submitting;
    assert.equal(pending.statusCode, 200, pending.body);
    assert.equal(pending.json().record.requestId, f.requestId);
    assert.equal(pending.json().stage, 'admitting_task');
    assert.equal(cancelled.statusCode, 200, cancelled.body);
    assert.equal(cancelled.json().record.control.state, 'cancelled');
    await f.integration.requests.recover();
    const current = await f.integration.requests.read(f.requestId, f.human);
    assert.equal(current.stage, 'cancelled');
    assert.equal(current.record.progress.review, undefined);
    assert.equal(calls, 1);
    const taskId = current.record.control?.task?.taskId;
    assert.ok(taskId);
    const task = f.tasks.get(taskId);
    assert.equal(task?.entrustedWork?.closure.state, 'cancelled', f.errors.map((error) => String(error)).join('\n'));
    assert.equal(
      task?.entrustedWork?.closure.state === 'cancelled' && task.entrustedWork.closure.disposition.actorRef,
      'user:operator',
    );
    assert.equal(f.store.returns.pending().length, 0);
    const catRead = await f.catRead();
    assert.equal(catRead.statusCode, 200, catRead.body);
    assert.equal(
      JSON.parse(catRead.json().json).stage,
      'cancelled',
      'the real cat callback reads cancellation even without a bound review',
    );
    await f.integration.requests.submit(f.payload, f.human);
    assert.equal(calls, 1, 'same operation stays cancelled on retry');
    assert.equal((await f.cancel()).json().record.control.receiptRef, cancelled.json().record.control.receiptRef);
    assert.equal((await f.cancel(f.requestId, { 'x-cat-cafe-user': 'stranger' })).statusCode, 404);
  });

test('cancelling one request preserves its existing Task and already retained source/proposals', async (t) => {
  const f = await fixture(t);
  const first = await f.integration.requests.submit(f.payload, f.human);
  assert.ok(first.record.progress.task);
  const originalTask = structuredClone(f.tasks.get(first.record.progress.task.taskId));
  const second = await f.integration.requests.submit(
    {
      ...f.payload,
      operationId: randomUUID(),
      taskContext: {
        kind: 'text',
        taskId: first.record.progress.task.taskId,
        expectedTaskRevision: first.record.progress.task.revision,
      },
    },
    f.human,
  );
  const source = await f.integration.text.read(second.record.requestId, f.cat);
  const returned = await f.integration.text.respond(
    {
      requestId: second.record.requestId,
      operationId: randomUUID(),
      expectedTaskRevision: second.record.progress.task!.revision,
      expectedProposalRevision: 0,
      baseRevision: source.source.source.revision,
      edits: [{ start: 4, end: 7, expectedText: 'old', replacement: 'new' }],
      response: '已更新',
    },
    f.cat,
  );
  const result = await f.cancel(second.record.requestId);
  assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(f.tasks.get(first.record.progress.task.taskId), originalTask);
  assert.equal((await f.integration.text.read(second.record.requestId, f.cat)).record.control?.state, 'cancelled');
  assert.equal(
    (await f.integration.results.candidates(result.json().record, f.human))[0]?.candidateRef,
    returned.proposal.proposalRef,
  );
  assert.equal((await f.integration.results.writeback(result.json().record, f.human))?.writable, false);
  await assert.rejects(
    f.integration.results.accept(
      {
        requestId: second.record.requestId,
        candidateRef: returned.proposal.proposalRef,
        acceptOperationId: randomUUID(),
        baseRevision: source.source.source.revision,
        locator: f.payload.source.locator,
        editSessionToken: signEditToken('work'),
      },
      f.human,
    ),
    /request_cancelled/,
  );
  assert.equal(await readFile(join(f.root, 'guide.md'), 'utf8'), 'The old text.');
  const firstCancelled = await f.cancel(first.record.requestId);
  assert.equal(firstCancelled.statusCode, 200, firstCancelled.body);
  assert.deepEqual(
    f.tasks.get(first.record.progress.task.taskId),
    originalTask,
    'the original request must also preserve a now-shared Task',
  );
});

test('a cancelled request outbox is retired even while its shared Task remains open', async (t) => {
  const f = await fixture(t);
  const first = await f.integration.requests.submit(f.payload, f.human);
  assert.ok(first.record.progress.task);
  const deliver = f.dispatch.delivery.deliver.bind(f.dispatch.delivery);
  f.dispatch.delivery.deliver = async () => {
    throw new Error('delivery temporarily unavailable');
  };
  const second = await f.integration.requests.submit(
    {
      ...f.payload,
      operationId: randomUUID(),
      taskContext: {
        kind: 'text',
        taskId: first.record.progress.task.taskId,
        expectedTaskRevision: first.record.progress.task.revision,
      },
    },
    f.human,
  );
  assert.ok(second.record.progress.review);
  assert.equal(f.store.returns.get(second.record.progress.review.receiptRef)?.state, 'pending');
  await f.cancel(second.record.requestId);
  let newDeliveries = 0;
  f.dispatch.delivery.deliver = async (input) => {
    newDeliveries += 1;
    return deliver(input);
  };
  await f.dispatcher.drain();
  assert.equal(newDeliveries, 0);
  assert.equal(f.store.returns.get(second.record.progress.review.receiptRef)?.retirementReason, 'request_cancelled');
  assert.equal(f.tasks.get(first.record.progress.task.taskId)?.entrustedWork?.closure.state, 'open');
});

test('missing Task lookup stays unknown across recovery and closes the original late Task when it is found', async (t) => {
  const f = await fixture(t),
    admit = f.tasks.admitEntrustedWork.bind(f.tasks),
    lookup = f.tasks.getBySubject.bind(f.tasks);
  let enter!: () => void,
    release!: () => void,
    lookupUnavailable = true;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  f.tasks.admitEntrustedWork = async (input) => {
    const result = await admit(input);
    enter();
    await blocked;
    return result;
  };
  const submitting = f.integration.requests.submit(f.payload, f.human);
  await entered;
  f.tasks.getBySubject = async (key) => (lookupUnavailable ? null : lookup(key));
  assert.equal((await f.cancel()).json().record.control.taskResolution, 'unknown');
  release();
  await submitting;
  for (let index = 0; index < 3; index++) await f.integration.requests.recover();
  assert.equal((await f.integration.requests.read(f.requestId, f.human)).record.control?.taskResolution, 'unknown');
  lookupUnavailable = false;
  await f.integration.requests.recover();
  assert.equal((await f.integration.requests.read(f.requestId, f.human)).record.control?.taskResolution, 'closed');
  assert.equal(f.tasks.listByThread(f.thread.id).length, 2, 'fixture Task plus the single original admission');
});
