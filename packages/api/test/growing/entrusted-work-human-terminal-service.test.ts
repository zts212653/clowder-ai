import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EntrustedWorkTaskExecutionStopV1, EntrustedWorkTaskExecutionV1, TaskItem } from '@cat-cafe/shared';
import { type IMessageStore, MessageStore } from '../../src/domains/cats/services/stores/ports/MessageStore.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import {
  EntrustedWorkHumanTerminalError,
  EntrustedWorkHumanTerminalService,
} from '../../src/domains/growing/EntrustedWorkHumanTerminalService.js';
import { EntrustedWorkLifecycleService } from '../../src/domains/growing/EntrustedWorkLifecycleService.js';
import type { EntrustedWorkTaskExecutionInspection } from '../../src/domains/growing/EntrustedWorkTaskExecutionService.js';

const decisionId = 'b5e80c62-2a8c-4554-8e72-9cf22ac0214a';

async function admittedFixture(
  options: {
    projectionState?: 'idle' | 'running' | 'unknown';
    runningBinding?: { threadId: string; catId: string };
    messages?: Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey'>;
    failFirstAppend?: boolean;
  } = {},
) {
  const tasks = new TaskStore();
  const lifecycle = new EntrustedWorkLifecycleService(tasks, { now: () => 100 });
  const admission = await lifecycle.admitOrResume({
    task: {
      threadId: 'thread-original',
      title: 'Prepare the thing',
      why: 'Owner asked',
      createdBy: 'user',
      userId: 'operator',
    },
    admission: {
      basis: 'explicit_entrustment',
      sourceRefs: ['message:source'],
      intendedOutcome: 'The thing is ready',
      idempotencyKey: `message:source#${Math.random()}`,
    },
    closure: { condition: 'Owner decides', expectedSignal: 'owner_decision' },
  });
  if (admission.result === 'needs_clarification') throw new Error('fixture admission failed');
  const taskId = admission.ownerRef.slice('task:item:'.length);
  const messageStore = new MessageStore();
  let appendAttempts = 0;
  const messages =
    options.messages ??
    ({
      getByIdempotencyKey: (...args: Parameters<IMessageStore['getByIdempotencyKey']>) =>
        messageStore.getByIdempotencyKey(...args),
      appendIdempotent: (...args: Parameters<IMessageStore['appendIdempotent']>) => {
        appendAttempts += 1;
        if (options.failFirstAppend && appendAttempts === 1) throw new Error('simulated append outage');
        return messageStore.appendIdempotent(...args);
      },
    } satisfies Pick<IMessageStore, 'appendIdempotent' | 'getByIdempotencyKey'>);

  const stopCalls: EntrustedWorkTaskExecutionInspection[] = [];
  const inspectCalls: TaskItem[] = [];
  const projectionFor = (task: TaskItem): EntrustedWorkTaskExecutionV1 => {
    const base = {
      v: 1 as const,
      scope: 'task_binding' as const,
      observedAt: 101,
      taskRef: {
        taskId,
        subjectRef: `task:work:${taskId}`,
        ownerRef: `task:item:${taskId}`,
        revision: task.entrustedWork?.revision ?? 1,
      },
    };
    if (options.projectionState === 'running') {
      const binding = options.runningBinding ?? { threadId: task.threadId, catId: 'codex-sol' };
      return {
        ...base,
        state: 'running',
        reasonCode: 'exact_parent_running',
        canConfirmSatisfied: false,
        binding: { leaseId: 'lease-a', generation: 1, ...binding },
        execution: { parentInvocationId: 'parent-a' },
      };
    }
    if (options.projectionState === 'unknown') {
      return {
        ...base,
        state: 'unknown',
        reasonCode: 'execution_truth_unavailable',
        canConfirmSatisfied: false,
      };
    }
    return {
      ...base,
      state: 'idle',
      reasonCode: 'unassigned_without_binding',
      canConfirmSatisfied: true,
    };
  };
  const stopped: EntrustedWorkTaskExecutionStopV1 = {
    state: 'stopped',
    reasonCode: 'exact_tracker_execution_aborted',
    executionRefs: ['parent-a'],
  };
  const execution = {
    inspect: async (task: TaskItem): Promise<EntrustedWorkTaskExecutionInspection> => {
      inspectCalls.push(task);
      const projection = projectionFor(task);
      return projection.state === 'running'
        ? {
            projection,
            control: {
              parentInvocationId: projection.execution.parentInvocationId,
              threadId: projection.binding.threadId,
              userId: task.userId ?? '',
              catId: projection.binding.catId,
            },
          }
        : { projection };
    },
    stopAfterTerminal: async (_task: TaskItem, inspection: EntrustedWorkTaskExecutionInspection) => {
      stopCalls.push(inspection);
      return options.projectionState === 'running' && inspection.control
        ? stopped
        : inspection.projection.state === 'running'
          ? ({ state: 'unknown', reasonCode: 'execution_control_unavailable', executionRefs: [] } as const)
          : ({ state: 'not_running', reasonCode: 'task_binding_idle', executionRefs: [] } as const);
    },
  };
  let clock = 110;
  const service = new EntrustedWorkHumanTerminalService({
    tasks,
    lifecycle,
    messages,
    execution,
    now: () => clock++,
  });
  return { tasks, taskId, messageStore, service, stopCalls, inspectCalls };
}

describe('F310 authenticated human terminal orchestration', () => {
  test('satisfied requires a fresh Task-binding idle observation and stores server evidence', async () => {
    const f = await admittedFixture();
    const result = await f.service.decide({
      taskId: f.taskId,
      userId: 'operator',
      input: { v: 1, decisionId, expectedRevision: 1, decision: { state: 'satisfied' } },
    });

    assert.equal(result.status, 'closed');
    assert.equal(result.task.entrustedWork?.closure.state, 'satisfied');
    if (result.task.entrustedWork?.closure.state !== 'satisfied') throw new Error('expected satisfied closure');
    const confirmation = result.task.entrustedWork.closure.confirmation;
    assert.equal(confirmation?.actorRef, 'user:operator');
    assert.equal(confirmation?.decisionRef, `task:work:${f.taskId}#human-decision:${decisionId}`);
    assert.equal(confirmation?.taskExecution.state, 'idle');
    assert.deepEqual(result.task.entrustedWork.closure.evidenceRefs, [confirmation?.decisionRef]);
    assert.equal(result.execution.stop.state, 'not_requested');
    assert.equal(result.receipt.message.content, '我确认这件已经完成。');
    assert.equal(f.messageStore.getByThread('thread-original', 10, 'operator').length, 1);
  });

  test('running or unknown execution rejects satisfied without closing Task or writing a success receipt', async () => {
    for (const projectionState of ['running', 'unknown'] as const) {
      const f = await admittedFixture({ projectionState });
      await assert.rejects(
        () =>
          f.service.decide({
            taskId: f.taskId,
            userId: 'operator',
            input: { v: 1, decisionId, expectedRevision: 1, decision: { state: 'satisfied' } },
          }),
        (error: unknown) =>
          error instanceof EntrustedWorkHumanTerminalError && error.code === 'HUMAN_TERMINAL_EXECUTION_NOT_IDLE',
      );
      assert.equal((await f.tasks.get(f.taskId))?.entrustedWork?.closure.state, 'open');
      assert.equal(f.messageStore.getByThread('thread-original', 10, 'operator').length, 0);
    }
  });

  test('cancel records the human reason, exact stop result, and one original-Thread receipt', async () => {
    const f = await admittedFixture({ projectionState: 'running' });
    const result = await f.service.decide({
      taskId: f.taskId,
      userId: 'operator',
      input: {
        v: 1,
        decisionId,
        expectedRevision: 1,
        decision: { state: 'cancelled', reason: 'No longer needed' },
      },
    });

    assert.equal(result.task.entrustedWork?.closure.state, 'cancelled');
    if (result.task.entrustedWork?.closure.state !== 'cancelled') throw new Error('expected cancelled closure');
    assert.equal(result.task.entrustedWork.closure.disposition.reason, 'No longer needed');
    assert.equal(result.task.entrustedWork.closure.disposition.taskExecution.state, 'running');
    assert.equal(result.execution.stop.state, 'stopped');
    assert.equal(result.receipt.message.content, '我不再继续这件。');
    assert.equal(result.receipt.receipt.execution.stop.state, 'stopped');
    assert.equal(f.stopCalls.length, 1);
    assert.equal(f.messageStore.getByThread('thread-original', 10, 'operator').length, 1);

    const lateOwnerCallback = await f.tasks.closeEntrustedWork(f.taskId, {
      expectedRevision: 2,
      closure: {
        condition: 'late callback',
        expectedSignal: 'late',
        state: 'satisfied',
        evidenceRefs: ['callback:late'],
      },
    });
    assert.equal(lateOwnerCallback.kind, 'already_closed');
    assert.equal((await f.tasks.get(f.taskId))?.entrustedWork?.closure.state, 'cancelled');
  });

  test('same decision repairs an append failure and then replays without duplicate message or stop', async () => {
    const f = await admittedFixture({ projectionState: 'running', failFirstAppend: true });
    const command = {
      taskId: f.taskId,
      userId: 'operator',
      input: {
        v: 1 as const,
        decisionId,
        expectedRevision: 1,
        decision: { state: 'cancelled' as const, reason: 'No longer needed' },
      },
    };
    await assert.rejects(() => f.service.decide(command), /simulated append outage/);
    assert.equal((await f.tasks.get(f.taskId))?.entrustedWork?.closure.state, 'cancelled');
    assert.equal(f.messageStore.getByThread('thread-original', 10, 'operator').length, 0);

    const recovered = await f.service.decide(command);
    assert.equal(recovered.status, 'replayed');
    assert.equal(recovered.execution.stop.state, 'stopped');
    assert.equal(f.inspectCalls.length, 1, 'receipt repair must reuse the terminal Task snapshot');
    assert.equal(f.messageStore.getByThread('thread-original', 10, 'operator').length, 1);
    const stopCountAfterRecovery = f.stopCalls.length;

    const replayed = await f.service.decide(command);
    assert.equal(replayed.status, 'replayed');
    assert.equal(f.messageStore.getByThread('thread-original', 10, 'operator').length, 1);
    assert.equal(f.stopCalls.length, stopCountAfterRecovery);
  });

  test('receipt repair reconstructs exact delegated child control from the persisted terminal decision', async () => {
    const f = await admittedFixture({
      projectionState: 'running',
      runningBinding: { threadId: 'thread-approved-child', catId: 'codex6-luna' },
      failFirstAppend: true,
    });
    const command = {
      taskId: f.taskId,
      userId: 'operator',
      input: {
        v: 1 as const,
        decisionId,
        expectedRevision: 1,
        decision: { state: 'cancelled' as const, reason: 'No longer needed' },
      },
    };
    await assert.rejects(() => f.service.decide(command), /simulated append outage/);

    const recovered = await f.service.decide(command);
    assert.equal(recovered.execution.stop.state, 'stopped');
    assert.deepEqual(f.stopCalls.at(-1)?.control, {
      parentInvocationId: 'parent-a',
      threadId: 'thread-approved-child',
      userId: 'operator',
      catId: 'codex6-luna',
    });
  });

  test('concurrent submissions of one decision converge on one Task transition and one receipt', async () => {
    const f = await admittedFixture({ projectionState: 'running' });
    const command = {
      taskId: f.taskId,
      userId: 'operator',
      input: {
        v: 1 as const,
        decisionId,
        expectedRevision: 1,
        decision: { state: 'cancelled' as const, reason: 'No longer needed' },
      },
    };
    const results = await Promise.all([f.service.decide(command), f.service.decide(command)]);
    assert.deepEqual(new Set(results.map((result) => result.status)), new Set(['closed', 'replayed']));
    assert.equal(results[0]?.receipt.message.id, results[1]?.receipt.message.id);
    const closed = await f.tasks.get(f.taskId);
    if (closed?.entrustedWork?.closure.state !== 'cancelled') throw new Error('expected cancelled closure');
    assert.equal(results[0]?.receipt.receipt.decision.decidedAt, closed.entrustedWork.closure.disposition.disposedAt);
    assert.equal(f.messageStore.getByThread('thread-original', 10, 'operator').length, 1);
    assert.equal(closed.entrustedWork.revision, 2);
    assert.equal(f.stopCalls.length, 1);
  });

  test('foreign owner, stale revision, and a different late decision fail with zero receipt', async () => {
    const f = await admittedFixture();
    await assert.rejects(
      () =>
        f.service.decide({
          taskId: f.taskId,
          userId: 'someone-else',
          input: { v: 1, decisionId, expectedRevision: 1, decision: { state: 'satisfied' } },
        }),
      (error: unknown) => error instanceof EntrustedWorkHumanTerminalError && error.code === 'HUMAN_TERMINAL_FORBIDDEN',
    );
    await assert.rejects(
      () =>
        f.service.decide({
          taskId: f.taskId,
          userId: 'operator',
          input: { v: 1, decisionId, expectedRevision: 9, decision: { state: 'satisfied' } },
        }),
      (error: unknown) =>
        error instanceof EntrustedWorkHumanTerminalError && error.code === 'HUMAN_TERMINAL_REVISION_CONFLICT',
    );
    assert.equal(f.messageStore.getByThread('thread-original', 10, 'operator').length, 0);

    await f.service.decide({
      taskId: f.taskId,
      userId: 'operator',
      input: { v: 1, decisionId, expectedRevision: 1, decision: { state: 'satisfied' } },
    });
    await assert.rejects(
      () =>
        f.service.decide({
          taskId: f.taskId,
          userId: 'operator',
          input: {
            v: 1,
            decisionId: '2b28a73d-ab86-4a30-9130-3b92711215a6',
            expectedRevision: 1,
            decision: { state: 'satisfied' },
          },
        }),
      (error: unknown) =>
        error instanceof EntrustedWorkHumanTerminalError && error.code === 'HUMAN_TERMINAL_ALREADY_CLOSED',
    );
    assert.equal(f.messageStore.getByThread('thread-original', 10, 'operator').length, 1);
  });
});
