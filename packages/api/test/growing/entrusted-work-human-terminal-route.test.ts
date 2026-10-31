import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EntrustedWorkTaskExecutionV1, TaskItem } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { EntrustedWorkHumanTerminalService } from '../../src/domains/growing/EntrustedWorkHumanTerminalService.js';
import { EntrustedWorkLifecycleService } from '../../src/domains/growing/EntrustedWorkLifecycleService.js';
import type { SocketManager } from '../../src/infrastructure/websocket/index.js';
import { tasksRoutes } from '../../src/routes/tasks.js';

const decisionId = 'b5e80c62-2a8c-4554-8e72-9cf22ac0214a';

async function harness(withHumanTerminal = true) {
  const tasks = new TaskStore();
  const messages = new MessageStore();
  const lifecycle = new EntrustedWorkLifecycleService(tasks, { now: () => 100 });
  const admission = await lifecycle.admitOrResume({
    task: {
      threadId: 'thread-route',
      title: 'Route work',
      why: '',
      createdBy: 'user',
      userId: 'operator',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source'],
      intendedOutcome: 'Done',
      idempotencyKey: `route:${Math.random()}`,
    },
    closure: { condition: 'Owner decides', expectedSignal: 'owner_decision' },
  });
  if (admission.result === 'needs_clarification') throw new Error('fixture failed');
  const taskId = admission.ownerRef.slice('task:item:'.length);
  const execution = {
    inspect: async (task: TaskItem) => {
      const projection: EntrustedWorkTaskExecutionV1 = {
        v: 1,
        scope: 'task_binding',
        state: 'idle',
        reasonCode: 'unassigned_without_binding',
        canConfirmSatisfied: true,
        observedAt: 101,
        taskRef: {
          taskId: task.id,
          subjectRef: `task:work:${task.id}`,
          ownerRef: `task:item:${task.id}`,
          revision: task.entrustedWork?.revision ?? 1,
        },
      };
      return { projection };
    },
    stopAfterTerminal: async () => ({
      state: 'not_running' as const,
      reasonCode: 'task_binding_idle' as const,
      executionRefs: [],
    }),
  };
  const humanTerminal = new EntrustedWorkHumanTerminalService({
    tasks,
    lifecycle,
    messages,
    execution,
    now: () => 110,
  });
  const events: Array<{ method: string; event: string; data: unknown }> = [];
  const socketManager = {
    broadcastToRoom: (_room: string, event: string, data: unknown) => events.push({ method: 'room', event, data }),
    emitToUser: (_userId: string, event: string, data: unknown) => events.push({ method: 'user', event, data }),
  } as SocketManager;
  const app = Fastify();
  await app.register(tasksRoutes, {
    taskStore: tasks,
    socketManager,
    ...(withHumanTerminal ? { humanTerminal } : {}),
  });
  return { app, tasks, messages, taskId, events };
}

describe('F310 human terminal HTTP contract', () => {
  test('server-authenticated action closes Task and publishes its original-Thread receipt', async () => {
    const f = await harness();
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/tasks/${f.taskId}/entrusted-work/human-terminal`,
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { v: 1, decisionId, expectedRevision: 1, decision: { state: 'satisfied' } },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().task.entrustedWork.closure.confirmation.actorRef, 'user:operator');
    assert.equal(
      response.json().receipt.receipt.decision.decisionRef,
      `task:work:${f.taskId}#human-decision:${decisionId}`,
    );
    assert.equal(f.messages.getByThread('thread-route', 10, 'operator').length, 1);
    assert.ok(f.events.some((event) => event.event === 'task_updated'));
    assert.ok(f.events.some((event) => event.event === 'messages_delivered'));
    await f.app.close();
  });

  test('client cannot nominate actor/evidence and legacy arbitrary-evidence close is retired', async () => {
    const f = await harness();
    const forged = await f.app.inject({
      method: 'POST',
      url: `/api/tasks/${f.taskId}/entrusted-work/human-terminal`,
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: {
        v: 1,
        decisionId,
        expectedRevision: 1,
        decision: { state: 'satisfied' },
        evidenceRefs: ['task:self-nominated'],
      },
    });
    assert.equal(forged.statusCode, 400);
    assert.equal((await f.tasks.get(f.taskId))?.entrustedWork?.closure.state, 'open');

    const legacy = await f.app.inject({
      method: 'POST',
      url: `/api/tasks/${f.taskId}/entrusted-work/close`,
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: {
        expectedRevision: 1,
        closure: {
          state: 'satisfied',
          condition: 'done',
          expectedSignal: 'done',
          evidenceRefs: ['task:self-nominated'],
        },
      },
    });
    assert.equal(legacy.statusCode, 409);
    assert.equal(legacy.json().code, 'HUMAN_TERMINAL_ROUTE_REQUIRED');
    assert.equal((await f.tasks.get(f.taskId))?.entrustedWork?.closure.state, 'open');
    await f.app.close();
  });

  test('fails closed when the authoritative human terminal composition is unavailable', async () => {
    const f = await harness(false);
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/tasks/${f.taskId}/entrusted-work/human-terminal`,
      headers: { 'x-cat-cafe-user': 'operator' },
      payload: { v: 1, decisionId, expectedRevision: 1, decision: { state: 'satisfied' } },
    });
    assert.equal(response.statusCode, 503);
    assert.equal((await f.tasks.get(f.taskId))?.entrustedWork?.closure.state, 'open');
    await f.app.close();
  });
});
