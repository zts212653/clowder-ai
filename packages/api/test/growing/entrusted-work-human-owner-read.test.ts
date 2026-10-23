import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { EntrustedWorkTaskExecutionV1 } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationRegistry } from '../../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { TaskStore } from '../../src/domains/cats/services/stores/ports/TaskStore.js';
import { EntrustedWorkLifecycleService } from '../../src/domains/growing/EntrustedWorkLifecycleService.js';
import { EntrustedWorkOwnerReadService } from '../../src/domains/growing/EntrustedWorkOwnerReadService.js';
import { registerEntrustedWorkReadRoutes } from '../../src/routes/entrusted-work-read-routes.js';

const producerCatalog = {
  listCurrentReceipts: async () => [],
  readCurrentReceipts: async () => ({ receipts: [], coverage: { state: 'complete' as const } }),
};

async function admittedFixture() {
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
      idempotencyKey: 'message:source#custody',
    },
    closure: { condition: 'Owner decides', expectedSignal: 'owner_decision' },
  });
  if (admission.result === 'needs_clarification') throw new Error('fixture admission failed');
  return { tasks, lifecycle, taskId: admission.ownerRef.slice('task:item:'.length) };
}

describe('F310 cancelled history and execution owner-read', () => {
  test('cancelled work is findable only through inert cancelled history', async () => {
    const f = await admittedFixture();
    await f.lifecycle.update({
      taskId: f.taskId,
      expectedRevision: 1,
      artifactRefs: ['artifact:mutable-current'],
    });
    const decisionRef = `task:work:${f.taskId}#human-decision:b5e80c62-2a8c-4554-8e72-9cf22ac0214a`;
    await f.lifecycle.close({
      taskId: f.taskId,
      expectedRevision: 2,
      closure: {
        condition: 'Owner decides',
        expectedSignal: 'owner_decision',
        state: 'cancelled',
        evidenceRefs: [decisionRef],
        disposition: {
          kind: 'cancelled',
          actorKind: 'human',
          actorRef: 'user:operator',
          authorityRef: `task:item:${f.taskId}#human-terminal:b5e80c62-2a8c-4554-8e72-9cf22ac0214a`,
          dispositionRef: decisionRef,
          disposedAt: 110,
          reason: 'No longer needed',
        },
      },
    });
    assert.equal((await f.tasks.get(f.taskId))?.entrustedWork?.completion, undefined);
    const reader = new EntrustedWorkOwnerReadService({
      tasks: f.tasks,
      producerCatalog,
      artifactReader: {
        async readPreparedArtifact() {
          return {
            artifactRef: 'artifact:mutable-current',
            artifactRevision: 'unsealed-current',
            completenessRef: 'publication:unsealed-current',
            previewRef: 'preview:unsealed-current',
            openInWorkspaceRef: 'workspace:unsealed-current',
          };
        },
      },
    });

    assert.deepEqual(await reader.listForOwner('operator', 'active'), []);
    assert.deepEqual(await reader.listForOwner('operator', 'completed'), []);
    const [cancelled] = await reader.listForOwner('operator', 'cancelled');
    assert.ok(cancelled);
    assert.equal(cancelled.terminal?.state, 'cancelled');
    assert.equal(cancelled.terminal?.disposition.reason, 'No longer needed');
    assert.equal(cancelled.work?.threadId, 'thread-original');
    assert.equal(cancelled.completion, undefined);
    assert.equal(cancelled.preparedArtifact, undefined, 'cancelled history must not expose mutable unsealed bytes');
    assert.deepEqual(cancelled.attentionReceipts, []);
    assert.deepEqual(cancelled.brief.nextOwner, { kind: 'unknown' });
    assert.equal(cancelled.brief.verifiedMilestone.kind, 'work_cancelled');

    const direct = await reader.read({
      taskId: f.taskId,
      includeCancelled: true,
      viewer: { surface: 'human', userId: 'operator' },
    });
    assert.equal(direct.terminal?.state, 'cancelled');
    await assert.rejects(
      () =>
        reader.read({
          taskId: f.taskId,
          includeCompleted: true,
          viewer: { surface: 'human', userId: 'operator' },
        }),
      (error: { code?: string }) => error.code === 'OWNER_READ_TERMINAL',
    );
  });

  test('active owner-read returns the injected exact Task execution projection', async () => {
    const f = await admittedFixture();
    const task = await f.tasks.get(f.taskId);
    assert.ok(task?.entrustedWork);
    const execution: EntrustedWorkTaskExecutionV1 = {
      v: 1,
      scope: 'task_binding',
      state: 'unknown',
      reasonCode: 'binding_source_unavailable',
      canConfirmSatisfied: false,
      observedAt: 120,
      taskRef: {
        taskId: f.taskId,
        subjectRef: `task:work:${f.taskId}`,
        ownerRef: `task:item:${f.taskId}`,
        revision: task.entrustedWork.revision,
      },
    };
    const reader = new EntrustedWorkOwnerReadService({
      tasks: f.tasks,
      producerCatalog,
      taskExecution: { read: async () => execution },
    });

    const ownerRead = await reader.read({ taskId: f.taskId, viewer: { surface: 'human', userId: 'operator' } });
    assert.deepEqual(ownerRead.execution, execution);
  });

  test('Web list/direct and invocation-bound callback consume the same cancelled history', async () => {
    const f = await admittedFixture();
    const decisionRef = `task:work:${f.taskId}#human-decision:b5e80c62-2a8c-4554-8e72-9cf22ac0214a`;
    await f.lifecycle.close({
      taskId: f.taskId,
      expectedRevision: 1,
      closure: {
        condition: 'Owner decides',
        expectedSignal: 'owner_decision',
        state: 'cancelled',
        evidenceRefs: [decisionRef],
        disposition: {
          kind: 'cancelled',
          actorKind: 'human',
          actorRef: 'user:operator',
          authorityRef: `task:item:${f.taskId}#human-terminal:b5e80c62-2a8c-4554-8e72-9cf22ac0214a`,
          dispositionRef: decisionRef,
          disposedAt: 110,
          reason: 'No longer needed',
        },
      },
    });
    const service = new EntrustedWorkOwnerReadService({ tasks: f.tasks, producerCatalog });
    const registry = new InvocationRegistry();
    const app = Fastify();
    registerEntrustedWorkReadRoutes(app, { service, callbackRegistry: registry });

    const list = await app.inject({
      method: 'GET',
      url: '/api/entrusted-work/owner-reads?view=cancelled',
      headers: { 'x-cat-cafe-user': 'operator' },
    });
    assert.equal(list.statusCode, 200, list.body);
    assert.equal(list.json().ownerReads[0].terminal.state, 'cancelled');

    const direct = await app.inject({
      method: 'GET',
      url: `/api/entrusted-work/${f.taskId}/owner-read?includeCancelled=true`,
      headers: { 'x-cat-cafe-user': 'operator' },
    });
    assert.equal(direct.statusCode, 200, direct.body);

    const credentials = await registry.create('operator', 'codex-sol', 'thread-original', undefined, undefined, {
      mode: 'read_only',
      replayDeniedToolNames: [],
    });
    const callback = await app.inject({
      method: 'POST',
      url: '/api/callbacks/read-entrusted-work',
      headers: {
        'x-invocation-id': credentials.invocationId,
        'x-callback-token': credentials.callbackToken,
      },
      payload: { taskId: f.taskId, includeCancelled: true },
    });
    assert.equal(callback.statusCode, 200, callback.body);
    assert.deepEqual(callback.json().ownerRead, direct.json().ownerRead);
    await app.close();
  });
});
