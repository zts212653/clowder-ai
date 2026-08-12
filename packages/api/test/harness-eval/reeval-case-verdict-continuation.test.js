import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectReevalCase } from '../../dist/infrastructure/harness-eval/reeval-case.js';
import { planReevalClosureEvents } from '../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js';

const caseId = `eval-case-v1-${'d'.repeat(64)}`;
const ref = (value) => ({ kind: 'verdict', availability: 'available', value });
const root = {
  schemaVersion: 2,
  caseId,
  findingKey: 'cadence-case',
  verdictId: 'week-a',
  domainId: 'eval:task-outcome',
  createdAt: '2026-08-01T00:00:00.000Z',
  verdict: 'keep_observe',
  harnessUnderEval: { featureId: 'F192', componentId: 'Phase-G-v0', name: 'Phase G' },
  ownerAsk: { targetFeatureId: 'F192', targetOwnerCatId: 'opus', requestedAction: 'observe' },
  acceptanceReevalPlan: { nextEvalAt: '2026-08-08T00:00:00.000Z', closureCondition: 'new verdict' },
};
const observed = {
  eventId: 'observe-week-a',
  caseId,
  verdictId: 'week-a',
  domainId: root.domainId,
  type: 'verdict_cycle_observed',
  actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
  occurredAt: '2026-08-01T00:01:00.000Z',
  cycleCreatedAt: root.createdAt,
  reason: 'observed',
  refs: [ref('verdict:week-a')],
};
const requested = {
  eventId: 'request-week-a',
  caseId,
  verdictId: 'week-a',
  domainId: root.domainId,
  type: 'reeval_requested',
  actor: { kind: 'cat', id: 'gpt52' },
  occurredAt: '2026-08-08T00:00:00.000Z',
  dueAt: '2026-08-10T00:00:00.000Z',
  assignedEvalCatId: 'gpt52',
  reason: 'scheduled',
  refs: [ref('verdict:week-a')],
};

function subject(nextVerdict) {
  const next = { ...root, verdictId: 'week-b', createdAt: '2026-08-08T01:00:00.000Z', verdict: nextVerdict };
  return {
    caseRoot: {
      caseId,
      domainId: root.domainId,
      targetOwnerCatId: 'opus',
      assignedEvalCatId: 'gpt52',
      cycles: [root, next].map(({ verdictId, createdAt, verdict }) => ({ verdictId, createdAt, verdict })),
    },
    roots: [root, next],
    assignedEvalCatId: 'gpt52',
    acknowledgeHours: 48,
    events: [observed, requested],
    openRefsByVerdictId: new Map([
      ['week-a', [ref('verdict:week-a')]],
      ['week-b', [ref('verdict:week-b')]],
    ]),
    responsibilityContext: {
      systemThreadId: 'thread_eval_task_outcome',
      featureId: 'F192',
      ownerCatId: 'opus',
      evalCatId: 'gpt52',
    },
  };
}

describe('F266 trusted verdict continuation', () => {
  it('closes or continues the same pending case without a duplicate orphan card', () => {
    for (const [verdict, resultType, status] of [
      ['keep_observe', 'reeval_passed', 'monitoring'],
      ['fix', 'reeval_failed', 'open'],
    ]) {
      const current = subject(verdict);
      const planned = planReevalClosureEvents(current, '2026-08-08T01:01:00.000Z');
      assert.deepEqual(
        planned.map((item) => item.event.type),
        ['verdict_cycle_observed', resultType],
      );
      const projection = projectReevalCase(current.caseRoot, [...current.events, ...planned.map((item) => item.event)]);
      assert.equal(projection.activeVerdictId, 'week-b');
      assert.equal(projection.status, status);
      assert.deepEqual(projection.observedVerdictIds, ['week-a', 'week-b']);
    }
  });
});
