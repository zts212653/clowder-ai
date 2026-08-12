import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { projectReevalCase } from '../../dist/infrastructure/harness-eval/reeval-case.js';
import { ReevalCaseReevaluationService } from '../../dist/infrastructure/harness-eval/reeval-case-reevaluation.js';

const caseId = `eval-case-v1-${'c'.repeat(64)}`;
const verdictId = 'legacy-monitor-week';
const root = {
  schemaVersion: 2,
  caseId,
  findingKey: 'phase-g-v0-control-plane',
  verdictId,
  domainId: 'eval:task-outcome',
  createdAt: '2026-08-02T03:00:00.000Z',
  verdict: 'keep_observe',
  harnessUnderEval: { featureId: 'F192', componentId: 'Phase-G-v0', name: 'Phase G' },
  ownerAsk: { targetFeatureId: 'F192', targetOwnerCatId: 'old-owner', requestedAction: 'keep observing' },
  acceptanceReevalPlan: {
    nextEvalAt: '2026-08-03T03:00:00.000Z',
    closureCondition: 'next trusted task-outcome verdict is recorded',
  },
};
const observed = {
  eventId: `f266:${caseId}:cycle:${verdictId}`,
  caseId,
  verdictId,
  domainId: root.domainId,
  type: 'verdict_cycle_observed',
  actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
  occurredAt: '2026-08-02T03:01:00.000Z',
  cycleCreatedAt: root.createdAt,
  reason: 'monitor cycle observed',
  refs: [{ kind: 'verdict', availability: 'available', value: `verdict:${verdictId}` }],
};

function subject(events) {
  return {
    caseRoot: {
      caseId,
      domainId: root.domainId,
      targetOwnerCatId: 'opus',
      assignedEvalCatId: 'gpt52',
      reevalWithinHours: 168,
      cycles: [{ verdictId, createdAt: root.createdAt, verdict: root.verdict }],
    },
    roots: [root],
    assignedEvalCatId: 'gpt52',
    acknowledgeHours: 48,
    events,
    openRefsByVerdictId: new Map([[verdictId, observed.refs]]),
    responsibilityContext: {
      systemThreadId: 'thread_eval_task_outcome',
      featureId: 'F192',
      ownerCatId: 'opus',
      evalCatId: 'gpt52',
    },
  };
}

class MemoryEventLog {
  constructor(events) {
    this.events = structuredClone(events);
  }
  async append(event, expectedSequence) {
    if (this.events.some((item) => item.eventId === event.eventId)) return { outcome: 'duplicate' };
    if (this.events.length !== expectedSequence) return { outcome: 'conflict', actualSequence: this.events.length };
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }
  async read() {
    return structuredClone(this.events);
  }
}

describe('F266 executable re-evaluation responsibility', () => {
  it('turns nextEvalAt into a real eval task, named owner, active lease, and case event', async () => {
    const taskStore = new TaskStore();
    const eventLog = new MemoryEventLog([observed]);
    const admissions = [];
    const service = new ReevalCaseReevaluationService({
      taskStore,
      eventLog,
      admissionService: {
        async admit(input) {
          admissions.push(structuredClone(input));
          const taskId = input.action.subjectRef.slice('subject:task:'.length);
          return {
            admit: true,
            outcome: 'claimed',
            lease: {
              leaseId: 'lease-reeval-1',
              generation: 1,
              status: 'active',
              subjectRef: `subject:task:${taskId}`,
              actionFamily: 'implement',
              successorSlot: 'implementer',
              holderCatIds: ['gpt52'],
              holderThreadId: 'thread_eval_task_outcome',
              tenantScope: 'user-1',
              terminalPredicate: { kind: 'task_done' },
            },
            fence: { leaseId: 'lease-reeval-1', generation: 1 },
          };
        },
      },
      ownerUserId: 'user-1',
      now: () => '2026-08-03T03:00:00.000Z',
    });
    const current = subject([observed]);

    assert.equal(await service.needsReconcile(current, '2026-08-03T02:59:59.999Z'), false);
    assert.equal(await service.needsReconcile(current, '2026-08-03T03:00:00.000Z'), true);
    const result = await service.reconcile(current, current.responsibilityContext);

    assert.equal(result.outcome, 'requested');
    const task = await taskStore.getBySubject(`eval-case:${caseId}:cycle:${verdictId}:reeval`);
    assert.ok(task);
    assert.equal(task.ownerCatId, 'gpt52');
    assert.equal(task.threadId, 'thread_eval_task_outcome');
    assert.equal(task.status, 'doing');
    assert.deepEqual(admissions[0].holderCatIds, ['gpt52']);
    const events = await eventLog.read(caseId);
    assert.equal(events.at(-1).type, 'reeval_requested');
    assert.equal(events.at(-1).reevalTaskId, task.id);
    assert.equal(events.at(-1).reevalLeaseId, 'lease-reeval-1');
    const projection = projectReevalCase(current.caseRoot, events);
    assert.equal(projection.status, 'reeval_pending');
    assert.equal(projection.reevalTaskId, task.id);

    const passed = {
      eventId: `f266:${caseId}:cycle:${verdictId}:passed`,
      caseId,
      verdictId,
      domainId: root.domainId,
      type: 'reeval_passed',
      actor: { kind: 'cat', id: 'gpt52' },
      occurredAt: '2026-08-04T03:00:00.000Z',
      assignedEvalCatId: 'gpt52',
      reason: 'trusted follow-up verdict passed',
      refs: [{ kind: 'reeval', availability: 'available', value: 'verdict:follow-up' }],
    };
    await eventLog.append(passed, events.length);
    const completed = subject(await eventLog.read(caseId));
    assert.equal(await service.needsReconcile(completed, '2026-08-04T03:00:00.000Z'), true);
    assert.equal((await service.reconcile(completed, completed.responsibilityContext)).outcome, 'settled');
    assert.equal((await taskStore.get(task.id)).status, 'done');
  });

  it('keeps the current repair task open when a failed re-evaluation has only older observed cycles', async () => {
    const taskStore = new TaskStore();
    const oldTask = await taskStore.upsertBySubject({
      threadId: 'thread_f192',
      title: 'Repair old cycle',
      why: 'historical responsibility',
      createdBy: 'opus',
      kind: 'work',
      subjectKey: `eval-case:${caseId}:cycle:week-old`,
      ownerCatId: 'opus',
      userId: 'user-1',
      relatedFeatureId: 'F192',
    });
    await taskStore.update(oldTask.id, { status: 'done' });
    const currentTask = await taskStore.upsertBySubject({
      threadId: 'thread_f192',
      title: 'Repair current cycle',
      why: 'current responsibility',
      createdBy: 'opus',
      kind: 'work',
      subjectKey: `eval-case:${caseId}:cycle:${verdictId}`,
      ownerCatId: 'opus',
      userId: 'user-1',
      relatedFeatureId: 'F192',
    });
    await taskStore.update(currentTask.id, { status: 'doing' });

    const cycle = (type, cycleVerdictId, occurredAt, extra = {}) => ({
      eventId: `${type}-${cycleVerdictId}`,
      caseId,
      verdictId: cycleVerdictId,
      domainId: root.domainId,
      type,
      actor:
        type === 'verdict_cycle_observed'
          ? { kind: 'automation', id: 'eval-verdict-closure-reconciler' }
          : type === 'responsibility_bound'
            ? { kind: 'automation', id: 'eval-verdict-closure-reconciler' }
            : type.startsWith('reeval_')
              ? { kind: 'cat', id: 'gpt52' }
              : { kind: 'cat', id: 'opus' },
      occurredAt,
      reason: `${type} evidence`,
      refs: [{ kind: 'verdict', availability: 'available', value: `verdict:${cycleVerdictId}` }],
      ...extra,
    });
    const oldVerdictId = 'week-old';
    const oldCreatedAt = '2026-07-25T03:00:00.000Z';
    const events = [
      cycle('verdict_cycle_observed', oldVerdictId, oldCreatedAt, { cycleCreatedAt: oldCreatedAt }),
      cycle('responsibility_bound', oldVerdictId, '2026-07-25T04:00:00.000Z', {
        taskId: oldTask.id,
        leaseId: 'lease-old',
        leaseGeneration: 1,
      }),
      cycle('action_planned', oldVerdictId, '2026-07-25T05:00:00.000Z'),
      cycle('main_landed', oldVerdictId, '2026-07-25T06:00:00.000Z', { commitSha: 'a'.repeat(40) }),
      cycle('live_active', oldVerdictId, '2026-07-25T07:00:00.000Z', { commitSha: 'a'.repeat(40) }),
      cycle('reeval_requested', oldVerdictId, '2026-07-26T03:00:00.000Z', {
        dueAt: '2026-07-27T03:00:00.000Z',
        assignedEvalCatId: 'gpt52',
      }),
      cycle('reeval_passed', oldVerdictId, '2026-07-26T04:00:00.000Z', { assignedEvalCatId: 'gpt52' }),
      cycle('verdict_cycle_observed', verdictId, root.createdAt, { cycleCreatedAt: root.createdAt }),
      cycle('responsibility_bound', verdictId, '2026-08-02T04:00:00.000Z', {
        taskId: currentTask.id,
        leaseId: 'lease-current',
        leaseGeneration: 1,
      }),
      cycle('action_planned', verdictId, '2026-08-02T05:00:00.000Z'),
      cycle('main_landed', verdictId, '2026-08-02T06:00:00.000Z', { commitSha: 'b'.repeat(40) }),
      cycle('live_active', verdictId, '2026-08-02T07:00:00.000Z', { commitSha: 'b'.repeat(40) }),
      cycle('reeval_requested', verdictId, '2026-08-03T03:00:00.000Z', {
        dueAt: '2026-08-04T03:00:00.000Z',
        assignedEvalCatId: 'gpt52',
      }),
      cycle('reeval_failed', verdictId, '2026-08-03T04:00:00.000Z', { assignedEvalCatId: 'gpt52' }),
    ];
    const current = {
      ...subject(events),
      caseRoot: {
        ...subject(events).caseRoot,
        cycles: [
          { verdictId: oldVerdictId, createdAt: oldCreatedAt, verdict: 'fix' },
          { verdictId, createdAt: root.createdAt, verdict: 'fix' },
        ],
      },
      roots: [
        { ...root, verdictId: oldVerdictId, createdAt: oldCreatedAt, verdict: 'fix' },
        { ...root, verdict: 'fix' },
      ],
    };
    const service = new ReevalCaseReevaluationService({
      taskStore,
      eventLog: new MemoryEventLog(events),
      admissionService: {
        async admit() {
          throw new Error('not expected');
        },
      },
      ownerUserId: 'user-1',
      now: () => '2026-08-03T05:00:00.000Z',
    });

    assert.equal((await service.reconcile(current, current.responsibilityContext)).outcome, 'not_due');
    assert.equal((await taskStore.get(currentTask.id)).status, 'doing');
  });
});
