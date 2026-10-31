import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import '../helpers/setup-cat-registry.js';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { InvocationTracker } from '../../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { EntrustedWorkHumanTerminalService } from '../../dist/domains/growing/EntrustedWorkHumanTerminalService.js';
import { EntrustedWorkLifecycleService } from '../../dist/domains/growing/EntrustedWorkLifecycleService.js';
import { EntrustedWorkTaskExecutionService } from '../../dist/domains/growing/EntrustedWorkTaskExecutionService.js';
import { sessionAuthPlugin, sessionRoute } from '../../dist/infrastructure/session-auth.js';
import { tasksRoutes } from '../../dist/routes/tasks.js';

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function fixture(assigned = false) {
  const tasks = new TaskStore();
  const messages = new MessageStore();
  const lifecycle = new EntrustedWorkLifecycleService(tasks);
  const admitted = await lifecycle.admitOrResume({
    task: {
      threadId: 'thread-review',
      title: 'Review work',
      why: '',
      createdBy: 'user',
      userId: 'operator',
      ...(assigned ? { ownerCatId: 'codex-sol' } : {}),
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source'],
      intendedOutcome: 'Ready',
      idempotencyKey: randomUUID(),
    },
    closure: { condition: 'Owner decides', expectedSignal: 'owner_decision' },
  });
  assert.notEqual(admitted.result, 'needs_clarification');
  const taskId = admitted.ownerRef.slice('task:item:'.length);
  const lease = {
    leaseId: 'lease-review',
    tenantScope: 'operator',
    subjectRef: `subject:task:${taskId}`,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['codex-sol'],
    holderThreadId: 'thread-review',
    generation: 2,
    status: 'active',
    dispatchDeliveryState: 'pending',
    terminalPredicate: { kind: 'task_done', subjectRef: `subject:task:${taskId}` },
  };
  let parents = [];
  const tracker = new InvocationTracker();
  const execution = new EntrustedWorkTaskExecutionService({
    leaseStore: { getByIdentity: async () => (assigned ? { ...lease } : null) },
    invocationRecords: {
      listRunningByThread: async () => parents.slice(),
      get: async (id) => parents.find((parent) => parent.id === id) ?? null,
    },
    turnExecutions: { listRunningByUser: async () => [] },
    tracker,
  });
  function start(id, generation = lease.generation) {
    parents = [
      {
        id,
        threadId: 'thread-review',
        userId: 'operator',
        targetCats: ['codex-sol'],
        status: 'running',
        actionLeaseCarrier: { kind: 'action_successor', leaseId: lease.leaseId, generation },
        userMessageId: 'message:carrier',
        intent: 'execute',
        idempotencyKey: id,
        createdAt: 1,
        updatedAt: 1,
      },
    ];
    lease.dispatchDeliveryState = 'delivered';
    return tracker.start('thread-review', 'codex-sol', 'operator', ['codex-sol'], id);
  }
  const terminalLifecycle = {
    close: async (command) => {
      const task = await lifecycle.close(command);
      lease.status = 'completed';
      return task;
    },
  };
  const human = new EntrustedWorkHumanTerminalService({
    tasks,
    messages,
    lifecycle: terminalLifecycle,
    execution,
  });
  return { tasks, messages, taskId, lease, execution, tracker, start, human, terminalLifecycle };
}

async function routeFixture() {
  const fixtureState = await fixture();
  const app = Fastify();
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'operator' });
  await app.register(tasksRoutes, {
    taskStore: fixtureState.tasks,
    humanTerminal: fixtureState.human,
    socketManager: { broadcastToRoom() {}, emitToUser() {} },
  });
  return { ...fixtureState, app };
}

test('remote unauthenticated header cannot manufacture a human cancellation', async () => {
  const f = await routeFixture();
  try {
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/tasks/${f.taskId}/entrusted-work/human-terminal`,
      remoteAddress: '203.0.113.19',
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: {
        v: 1,
        decisionId: randomUUID(),
        expectedRevision: 1,
        decision: { state: 'cancelled', reason: 'forged request' },
      },
    });
    assert.ok(
      [401, 403].includes(response.statusCode),
      `remote header-only request closed Task with ${response.statusCode}`,
    );
    assert.equal((await f.tasks.get(f.taskId)).entrustedWork.closure.state, 'open');
    assert.equal(f.messages.getByThread('thread-review', 10, 'operator').length, 0);
  } finally {
    await f.app.close();
  }
});

test('proxied loopback header cannot manufacture a human cancellation', async () => {
  const f = await routeFixture();
  try {
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/tasks/${f.taskId}/entrusted-work/human-terminal`,
      remoteAddress: '127.0.0.1',
      headers: { 'x-cat-cafe-user': 'operator', 'x-forwarded-for': '203.0.113.19' },
      payload: {
        v: 1,
        decisionId: randomUUID(),
        expectedRevision: 1,
        decision: { state: 'cancelled', reason: 'forged proxy request' },
      },
    });
    assert.ok(
      [401, 403].includes(response.statusCode),
      `proxied header-only request closed Task with ${response.statusCode}`,
    );
    assert.equal((await f.tasks.get(f.taskId)).entrustedWork.closure.state, 'open');
    assert.equal(f.messages.getByThread('thread-review', 10, 'operator').length, 0);
  } finally {
    await f.app.close();
  }
});

test('a server-issued owner session remains authorized from a remote peer', async () => {
  const f = await routeFixture();
  try {
    const login = await f.app.inject({ method: 'GET', url: '/api/session', remoteAddress: '127.0.0.1' });
    const sessionCookie = String(login.headers['set-cookie']).split(';')[0];
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/tasks/${f.taskId}/entrusted-work/human-terminal`,
      remoteAddress: '203.0.113.19',
      headers: { cookie: sessionCookie },
      payload: {
        v: 1,
        decisionId: randomUUID(),
        expectedRevision: 1,
        decision: { state: 'cancelled', reason: 'authenticated owner decision' },
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await f.tasks.get(f.taskId)).entrustedWork.closure.state, 'cancelled');
  } finally {
    await f.app.close();
  }
});

test('a queued carrier starting before Task CAS must not yield prevented_start', async () => {
  const f = await fixture(true);
  let controller;
  const racedExecution = {
    inspect: async (task) => {
      const inspection = await f.execution.inspect(task);
      assert.equal(inspection.projection.state, 'queued');
      controller = f.start('parent-started-during-close');
      return inspection;
    },
    stopAfterTerminal: (...args) => f.execution.stopAfterTerminal(...args),
  };
  const service = new EntrustedWorkHumanTerminalService({
    tasks: f.tasks,
    messages: f.messages,
    lifecycle: f.terminalLifecycle,
    execution: racedExecution,
  });
  const result = await service.decide({
    taskId: f.taskId,
    userId: 'operator',
    input: {
      v: 1,
      decisionId: randomUUID(),
      expectedRevision: 1,
      decision: { state: 'cancelled', reason: 'No longer needed' },
    },
  });
  assert.notEqual(
    result.execution.stop.state,
    'prevented_start',
    'already-running exact carrier was not stopped but receipt claims prevented_start',
  );
  assert.equal(controller.signal.aborted, true, 'the exact admitted carrier must be stopped');
});

test('CAS-losing replay uses persisted snapshot and never cancels a later replacement', async () => {
  const f = await fixture(true);
  f.start('parent-old');
  const aInspected = deferred();
  const releaseA = deferred();
  const bInspected = deferred();
  const releaseB = deferred();
  const command = {
    taskId: f.taskId,
    userId: 'operator',
    input: {
      v: 1,
      decisionId: randomUUID(),
      expectedRevision: 1,
      decision: { state: 'cancelled', reason: 'No longer needed' },
    },
  };
  const a = new EntrustedWorkHumanTerminalService({
    tasks: f.tasks,
    lifecycle: f.terminalLifecycle,
    messages: {
      getByIdempotencyKey: (...args) => f.messages.getByIdempotencyKey(...args),
      appendIdempotent() {
        throw new Error('append outage');
      },
    },
    execution: {
      inspect: async (task) => {
        const seen = await f.execution.inspect(task);
        aInspected.resolve();
        await releaseA.promise;
        return seen;
      },
      stopAfterTerminal: (...args) => f.execution.stopAfterTerminal(...args),
    },
  });
  const pa = a.decide(command);
  const aOutcome = pa.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await aInspected.promise;
  f.lease.generation = 3;
  const replacement = f.start('parent-replacement', 3);
  const b = new EntrustedWorkHumanTerminalService({
    tasks: f.tasks,
    messages: f.messages,
    lifecycle: f.terminalLifecycle,
    execution: {
      inspect: async (task) => {
        const seen = await f.execution.inspect(task);
        bInspected.resolve();
        await releaseB.promise;
        return seen;
      },
      stopAfterTerminal: (...args) => f.execution.stopAfterTerminal(...args),
    },
  });
  const pb = b.decide(command);
  await bInspected.promise;
  releaseA.resolve();
  assert.match((await aOutcome).error?.message ?? '', /append outage/);
  assert.equal(replacement.signal.aborted, false, 'winning decision correctly refused the replacement');
  releaseB.resolve();
  const result = await pb;
  assert.equal(replacement.signal.aborted, false, 'CAS-losing request aborted a replacement');
  assert.equal(result.execution.before.execution.parentInvocationId, 'parent-old');
  assert.deepEqual(result.execution.stop.executionRefs, ['parent-old']);
});
