import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskRecoveryReadModel } from '../dist/domains/ball-custody/TaskRecoveryReadModel.js';

const task = {
  id: 'task-original',
  kind: 'work',
  threadId: 'thread-original',
  subjectKey: null,
  title: 'Original task',
  ownerCatId: 'codex61-sol',
  status: 'blocked',
  why: 'waiting for the original condition',
  createdBy: 'user',
  createdAt: 1,
  updatedAt: 2,
};

test('one Task read joins action and probe dispositions without creating another owner', async () => {
  const model = new TaskRecoveryReadModel({
    action: {
      readRecoveryIncidents: async () => [
        {
          source: 'action_successor',
          lane: 'task',
          disposition: 'parked',
          reasonCode: 'task_recovery_read_failed',
          executionRef: 'action-successor:lease-1:g1:task',
        },
      ],
    },
    ball: {
      getRecoveryFacts: async (subjectKey) => ({
        v: 1,
        subjectKey,
        generation: 1,
        notices: {},
        probe: {
          scope: `${subjectKey}:g1`,
          revision: 6,
          failures: 5,
          nextAt: 0,
          disposition: 'needs_attention',
          reasonCode: 'ball_recovery_failed',
        },
      }),
    },
  });
  const projected = await model.project(task);
  assert.equal(projected.id, task.id);
  assert.equal(projected.recovery.ownerRef, `task:${task.id}`);
  assert.deepEqual(
    projected.recovery.incidents.map(({ source, reasonCode }) => [source, reasonCode]),
    [
      ['action_successor', 'task_recovery_read_failed'],
      ['ball_probe', 'ball_recovery_failed'],
    ],
  );
  assert.equal(task.recovery, undefined, 'the durable Task row is not rewritten into a second recovery ledger');
});

test('one corrupt recovery owner cannot hide healthy Tasks from the canonical list', async () => {
  const healthy = { ...task, id: 'task-healthy' };
  const corrupt = { ...task, id: 'task-corrupt' };
  const model = new TaskRecoveryReadModel({
    action: {
      readRecoveryIncidents: async (item) => {
        if (item.id === corrupt.id) throw new Error('invalid persisted action successor lease');
        return [
          {
            source: 'action_successor',
            lane: 'task',
            disposition: 'parked',
            reasonCode: 'healthy_owner_parked',
            executionRef: 'action-successor:healthy:g1:task',
          },
        ];
      },
    },
  });
  const projected = await model.projectMany([corrupt, healthy]);
  assert.equal(projected.length, 2);
  assert.equal(projected[0].id, corrupt.id);
  assert.equal(projected[0].recovery.ownerRef, `task:${corrupt.id}`);
  assert.equal(projected[0].recovery.incidents[0].reasonCode, 'action_recovery_read_failed');
  assert.equal(projected[1].recovery.incidents[0].reasonCode, 'healthy_owner_parked');
});

for (const reasonCode of ['invalid_recovery_metadata', 'invalid_projection'])
  test(`owner-level Ball ${reasonCode} remains visible on the original Task`, async () => {
    const model = new TaskRecoveryReadModel({
      ball: {
        getRecoveryFacts: async (subjectKey) => ({
          v: 1,
          subjectKey,
          generation: 0,
          notices: {},
          disposition: 'needs_attention',
          reasonCode,
          originalRaw: '{broken legacy bytes',
        }),
      },
    });
    const projected = await model.project(task);
    assert.deepEqual(projected.recovery.incidents, [
      {
        source: 'ball_probe',
        lane: 'probe',
        disposition: 'needs_attention',
        reasonCode,
        executionRef: `ball:task:${task.id}:owner`,
      },
    ]);
  });

test('ordinary Tasks retain historical action recovery evidence without regaining action authority', async () => {
  const { TaskActionSuccessorLifecycle } = await import('../dist/domains/ball-custody/TaskActionSuccessorLifecycle.js');
  const selected = {
    leaseId: 'lease-historical',
    tenantScope: 'owner-user',
    subjectRef: `subject:task:${task.id}`,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    generation: 3,
    status: 'active',
    holderCatIds: ['codex61-sol'],
    holderThreadId: task.threadId,
    terminalPredicate: { kind: 'task_done' },
  };
  let completions = 0;
  const lifecycle = new TaskActionSuccessorLifecycle({
    leaseStore: {
      getByIdentity: async () => selected,
      recovery: {
        read: async (_leaseId, lane) => ({
          lease: selected,
          revision: 1,
          fact: {
            v: 1,
            generation: 3,
            attempts: 5,
            nextAttemptAt: null,
            ...(lane === 'dispatch' ? { disposition: 'parked', reasonCode: 'historical_dispatch_failed' } : {}),
          },
        }),
      },
    },
    completionService: {
      complete: async () => {
        completions++;
        return { outcome: 'committed' };
      },
    },
  });
  const ordinary = { ...task, userId: 'owner-user' };
  assert.equal((await lifecycle.readRecoveryIncidents(ordinary))[0].reasonCode, 'historical_dispatch_failed');
  await lifecycle.assertUpdateAllowed(ordinary, { ownerCatId: 'somebody-else' });
  assert.equal(await lifecycle.completeStatusTransition(ordinary, { ...ordinary, status: 'done' }), false);
  assert.equal(completions, 0, 'read compatibility must not restore execution or completion authority');
});

test('action recovery projection re-reads the current owner after a replacement generation', async () => {
  const { TaskActionSuccessorLifecycle } = await import('../dist/domains/ball-custody/TaskActionSuccessorLifecycle.js');
  const selected = {
    leaseId: 'lease-selected',
    tenantScope: 'owner-user',
    subjectRef: `subject:task:${task.id}`,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    generation: 4,
    status: 'active',
    holderCatIds: ['codex61-sol'],
    holderThreadId: task.threadId,
    terminalPredicate: { kind: 'task_done' },
  };
  const replacement = { ...selected, generation: 5 };
  let identityReads = 0;
  const lifecycle = new TaskActionSuccessorLifecycle({
    leaseStore: {
      getByIdentity: async () => (identityReads++ === 0 ? selected : replacement),
      recovery: {
        read: async (_leaseId, lane) => ({
          lease: replacement,
          revision: 1,
          fact: {
            v: 1,
            generation: 5,
            attempts: 5,
            nextAttemptAt: null,
            disposition: 'parked',
            reasonCode: `${lane}_failed`,
          },
        }),
      },
    },
    completionService: { complete: async () => ({ outcome: 'committed' }) },
  });
  const incidents = await lifecycle.readRecoveryIncidents({
    ...task,
    subjectKey: 'entrusted:generation-fence',
    userId: 'owner-user',
  });
  assert.deepEqual(
    incidents.map(({ lane, executionRef }) => [lane, executionRef]),
    [
      ['return', 'action-successor:lease-selected:g5:return'],
      ['dispatch', 'action-successor:lease-selected:g5:dispatch'],
      ['task', 'action-successor:lease-selected:g5:task'],
    ],
  );
  assert.equal(identityReads, 2);
});
