import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ReevalCaseResponsibilityService } from '../../dist/infrastructure/harness-eval/reeval-case-responsibility.js';

const caseId = `eval-case-v1-${'a'.repeat(64)}`;
const verdictId = 'capability-wakeup-2026-08-01-rich-messaging';
const root = {
  schemaVersion: 2,
  caseId,
  findingKey: 'rich-messaging',
  verdictId,
  domainId: 'eval:capability-wakeup',
  createdAt: '2026-08-01T00:00:00.000Z',
  verdict: 'fix',
  harnessUnderEval: { featureId: 'F203', componentId: 'rich-messaging', name: 'rich-messaging' },
  ownerAsk: {
    targetFeatureId: 'F203',
    targetOwnerCatId: 'codex-sol',
    requestedAction: 'repair the activation path',
  },
  acceptanceReevalPlan: {
    nextEvalAt: '2026-08-08T00:00:00.000Z',
    closureCondition: 'the next real eval passes',
  },
};

const opened = {
  eventId: `f266:${caseId}:cycle:${verdictId}`,
  caseId,
  verdictId,
  domainId: root.domainId,
  type: 'verdict_cycle_observed',
  actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
  occurredAt: '2026-08-01T00:01:00.000Z',
  cycleCreatedAt: root.createdAt,
  reason: 'cycle attached to stable case',
  refs: [{ kind: 'verdict', availability: 'available', value: `docs/harness-feedback/verdicts/${verdictId}.md` }],
};

function subject(events = [opened]) {
  return {
    caseRoot: {
      caseId,
      domainId: root.domainId,
      targetOwnerCatId: 'codex-sol',
      assignedEvalCatId: 'gpt52',
      cycles: [{ verdictId, createdAt: root.createdAt }],
    },
    roots: [root],
    assignedEvalCatId: 'gpt52',
    acknowledgeHours: 48,
    events,
    openRefsByVerdictId: new Map([[verdictId, opened.refs]]),
  };
}

class MemoryEventLog {
  constructor(events = [opened]) {
    this.events = structuredClone(events);
  }

  async read(subjectId) {
    return subjectId === caseId ? structuredClone(this.events) : [];
  }

  async append(event, expectedSequence) {
    const duplicate = this.events.find((candidate) => candidate.eventId === event.eventId);
    if (duplicate) return { outcome: 'duplicate' };
    if (this.events.length !== expectedSequence) return { outcome: 'conflict', actualSequence: this.events.length };
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }
}

function matchingLease(taskId) {
  return {
    leaseId: 'lease-cycle-1',
    generation: 1,
    status: 'active',
    subjectRef: `subject:task:${taskId}`,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    holderCatIds: ['codex-sol'],
    holderThreadId: 'thread_f203',
    tenantScope: 'user-1',
    terminalPredicate: { kind: 'task_done' },
  };
}

function fixture(overrides = {}) {
  const taskStore = overrides.taskStore ?? new TaskStore();
  const eventLog = overrides.eventLog ?? new MemoryEventLog();
  const admissions = [];
  const admissionService = overrides.admissionService ?? {
    async admit(input) {
      admissions.push(structuredClone(input));
      const taskId = input.action.subjectRef.slice('subject:task:'.length);
      const lease = matchingLease(taskId);
      return { admit: true, outcome: 'claimed', lease, fence: { leaseId: lease.leaseId, generation: 1 } };
    },
  };
  const service = new ReevalCaseResponsibilityService({
    taskStore,
    eventLog,
    admissionService,
    resolveFeatureThreadId: overrides.resolveFeatureThreadId ?? (async () => 'thread_f203'),
    ownerUserId: 'user-1',
    now: () => '2026-08-01T01:00:00.000Z',
  });
  return { taskStore, eventLog, admissions, service };
}

describe('F266 case responsibility binding', () => {
  it('binds one cycle task and one matching F167 lease before acknowledging responsibility', async () => {
    const { taskStore, eventLog, admissions, service } = fixture();
    const result = await service.reconcile(subject(), {
      systemThreadId: 'thread_eval_capability_wakeup',
      featureId: 'F203',
      evalCatId: 'gpt52',
    });

    assert.equal(result.outcome, 'bound');
    const task = await taskStore.getBySubject(`eval-case:${caseId}:cycle:${verdictId}`);
    assert.ok(task);
    assert.equal(task.ownerCatId, 'codex-sol');
    assert.equal(task.threadId, 'thread_f203');
    assert.equal(task.userId, 'user-1');
    assert.equal(task.status, 'doing');
    assert.equal(admissions.length, 1);
    assert.deepEqual(admissions[0].holderCatIds, ['codex-sol']);
    assert.equal(admissions[0].sourceThreadId, 'thread_eval_capability_wakeup');
    assert.equal(admissions[0].targetThreadId, 'thread_f203');
    assert.equal(admissions[0].action.subjectRef, `subject:task:${task.id}`);
    assert.deepEqual(admissions[0].action.terminalPredicate, { kind: 'task_done' });

    const events = await eventLog.read(caseId);
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'responsibility_bound');
    assert.equal(events[1].taskId, task.id);
    assert.equal(events[1].leaseId, 'lease-cycle-1');
  });

  it('still binds durable responsibility after the acknowledgement SLA has escalated', async () => {
    const escalation = {
      eventId: `f266:${caseId}:cycle:${verdictId}:sla:acknowledgement:2026-08-03T00:00:00.000Z`,
      caseId,
      verdictId,
      domainId: root.domainId,
      type: 'sla_escalated',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      occurredAt: '2026-08-03T00:00:00.000Z',
      dueAt: '2026-08-03T00:00:00.000Z',
      stage: 'acknowledgement',
      reason: 'acknowledgement SLA elapsed',
      refs: [{ kind: 'sla', availability: 'available', value: `sla:${caseId}:acknowledgement` }],
    };
    const eventLog = new MemoryEventLog([opened, escalation]);
    const { service } = fixture({ eventLog });

    const result = await service.reconcile(subject([opened, escalation]), {
      systemThreadId: 'thread_eval_capability_wakeup',
      featureId: 'F203',
      evalCatId: 'gpt52',
    });

    assert.equal(result.outcome, 'bound');
    assert.equal((await eventLog.read(caseId)).at(-1).type, 'responsibility_bound');
  });

  it('fails before writing a task when feature-thread truth is absent or ambiguous', async () => {
    for (const reason of ['not_found', 'ambiguous']) {
      const taskStore = new TaskStore();
      const { service } = fixture({
        taskStore,
        resolveFeatureThreadId: async () => {
          throw new Error(`feature_thread_${reason}`);
        },
      });
      await assert.rejects(
        () => service.reconcile(subject(), { systemThreadId: 'thread_eval', featureId: 'F203', evalCatId: 'gpt52' }),
        new RegExp(reason),
      );
      assert.equal(await taskStore.getBySubject(`eval-case:${caseId}:cycle:${verdictId}`), null);
    }
  });

  it('recovers the same task after a task-before-lease crash and the same lease after a lease-before-event crash', async () => {
    const taskStore = new TaskStore();
    const eventLog = new MemoryEventLog();
    let attempts = 0;
    const admissionService = {
      async admit(input) {
        attempts += 1;
        if (attempts === 1) throw new Error('simulated_after_task_write');
        const taskId = input.action.subjectRef.slice('subject:task:'.length);
        const lease = matchingLease(taskId);
        return {
          admit: attempts === 2,
          outcome: attempts === 2 ? 'claimed' : 'replayed',
          lease,
          ...(attempts === 2 ? { fence: { leaseId: lease.leaseId, generation: 1 } } : {}),
        };
      },
    };
    const first = fixture({ taskStore, eventLog, admissionService });
    await assert.rejects(
      () =>
        first.service.reconcile(subject(), {
          systemThreadId: 'thread_eval',
          featureId: 'F203',
          evalCatId: 'gpt52',
        }),
      /simulated_after_task_write/,
    );
    const orphanTask = await taskStore.getBySubject(`eval-case:${caseId}:cycle:${verdictId}`);
    assert.ok(orphanTask);

    const bound = await first.service.reconcile(subject(), {
      systemThreadId: 'thread_eval',
      featureId: 'F203',
      evalCatId: 'gpt52',
    });
    assert.equal(bound.task.id, orphanTask.id);

    const staleSubject = subject();
    const replayed = await first.service.reconcile(staleSubject, {
      systemThreadId: 'thread_eval',
      featureId: 'F203',
      evalCatId: 'gpt52',
    });
    assert.equal(replayed.outcome, 'duplicate');
    assert.equal((await eventLog.read(caseId)).filter((event) => event.type === 'responsibility_bound').length, 1);
  });

  it('rejects a lease that does not match the task owner, thread, tenant, or task subject', async () => {
    const mismatches = [
      { holderCatIds: ['opus47'] },
      { holderThreadId: 'thread_other' },
      { tenantScope: 'user-other' },
      { subjectRef: 'subject:task:other-task' },
    ];
    for (const patch of mismatches) {
      const { service } = fixture({
        admissionService: {
          async admit(input) {
            const taskId = input.action.subjectRef.slice('subject:task:'.length);
            const lease = { ...matchingLease(taskId), ...patch };
            return { admit: false, outcome: 'safe_wait', lease };
          },
        },
      });
      await assert.rejects(
        () => service.reconcile(subject(), { systemThreadId: 'thread_eval', featureId: 'F203', evalCatId: 'gpt52' }),
        /lease does not match persisted task responsibility/,
      );
    }
  });
});
