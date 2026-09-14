import assert from 'node:assert/strict';
import { test } from 'node:test';

const { F257ApprovalAdapter } = await import('../dist/domains/approval-hub/adapters/F257ApprovalAdapter.js');

test('F257 approval projection carries visual metric deltas and the complete atomic action list', async () => {
  const proposal = {
    schemaVersion: 1,
    proposalId: 'HGP-1',
    ownerUserId: 'owner-1',
    objective: { id: 'obj', label: 'Objective', statement: 'Stay sound.' },
    objectiveId: 'obj',
    cycleId: 'cycle-2',
    threadId: 'thread_eval_f257_obj',
    cardOrdinal: 1,
    decision: 'evolve',
    status: 'pending',
    reason: 'The count improved but a hook still needs narrowing.',
    version: 'objective-v1',
    versionContentRef: 'harness-objective-version:obj:v1',
    windows: [{ start: 10, end: 20 }],
    triggeredBy: ['cumulative'],
    triggerCounts: { cumulative: { count: 200, threshold: 200 }, counterexamples: { count: 3, threshold: 3 } },
    evaluation: {
      overall: 'complete',
      metrics: [{ id: 'metric-a', conclusion: { kind: 'count', value: 2, howCounted: 'two' }, evidenceRefs: [] }],
      writtenAt: 20,
    },
    history: [
      {
        cycleId: 'cycle-1',
        version: 'objective-v0',
        windows: [{ start: 0, end: 10 }],
        evaluation: {
          overall: 'complete',
          metrics: [{ id: 'metric-a', conclusion: { kind: 'count', value: 5, howCounted: 'five' }, evidenceRefs: [] }],
          writtenAt: 10,
        },
      },
    ],
    rejectReasons: [],
    changes: [
      {
        action: 'disable',
        unitId: 'D1',
        hookId: 'D1',
        reason: 'Remove the redundant unit.',
        beforeEnabled: true,
        beforeContent: 'old body',
        objectiveImpact: { objectiveId: 'obj', remainingMemberCount: 1 },
      },
      {
        action: 'modify',
        unitId: 'D2',
        hookId: 'D2',
        reason: 'Narrow to serial mode.',
        sourceVersion: 1,
        beforeContent: 'body',
        beforeCondition: null,
        proposedCondition: { conditionRef: 'routing-mode-in', params: { values: ['serial'] } },
      },
    ],
    evidenceRefs: [],
    createdAt: 21,
  };
  const adapter = new F257ApprovalAdapter({ listByOwner: async () => [proposal] });
  const [item] = await adapter.listPending('owner-1');
  assert.deepEqual(item.detail.metricVisuals, [
    { id: 'metric-a', currentValue: 2, previousValue: 5, delta: -3, lowerIsBetter: true },
  ]);
  assert.equal(item.detail.hasComparisonBaseline, true);
  assert.equal(item.detail.changes.length, 2);
  assert.equal(item.detail.changes[0].objectiveImpact.remainingMemberCount, 1);
  assert.deepEqual(item.detail.changes[1].proposedCondition.params.values, ['serial']);
});
