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
