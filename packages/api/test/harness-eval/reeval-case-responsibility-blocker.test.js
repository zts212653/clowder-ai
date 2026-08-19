import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { ReevalCaseResponsibilityService } from '../../dist/infrastructure/harness-eval/reeval-case-responsibility.js';
import { createReevalClosureTaskSpec } from '../../dist/infrastructure/harness-eval/reeval-closure-task-spec.js';
import { FeatureThreadResolutionError } from '../../dist/routes/feature-thread-resolver.js';

const caseId = `eval-case-v1-${'c'.repeat(64)}`;
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
    targetOwnerCatId: 'opus-47',
    requestedAction: 'repair the activation path',
  },
  acceptanceReevalPlan: {
    nextEvalAt: '2026-08-08T00:00:00.000Z',
    closureCondition: 'the next real eval passes',
  },
};
const observed = {
  eventId: `f266:${caseId}:cycle:${verdictId}`,
  caseId,
  verdictId,
  domainId: root.domainId,
  type: 'verdict_cycle_observed',
  actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
  occurredAt: '2026-08-01T00:01:00.000Z',
  cycleCreatedAt: root.createdAt,
  reason: 'cycle attached to stable case',
  refs: [{ kind: 'verdict', availability: 'available', value: `verdict:${verdictId}` }],
};

function subject(events = [observed]) {
  return {
    caseRoot: {
      caseId,
      domainId: root.domainId,
      targetOwnerCatId: 'opus-47',
      assignedEvalCatId: 'gpt52',
      cycles: [{ verdictId, createdAt: root.createdAt, verdict: 'fix' }],
    },
    roots: [root],
    assignedEvalCatId: 'gpt52',
    acknowledgeHours: 48,
    events,
    openRefsByVerdictId: new Map([[verdictId, observed.refs]]),
    responsibilityContext: { systemThreadId: 'thread_eval', featureId: 'F203', evalCatId: 'gpt52' },
  };
}

class MemoryEventLog {
  constructor(events = [observed]) {
    this.events = structuredClone(events);
  }

  async read(subjectId) {
    return subjectId === caseId ? structuredClone(this.events) : [];
  }

  async append(event, expectedSequence) {
    if (this.events.some((candidate) => candidate.eventId === event.eventId)) return { outcome: 'duplicate' };
    if (this.events.length !== expectedSequence) return { outcome: 'conflict', actualSequence: this.events.length };
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }
}

function fixture(resolveFeatureThreadId, eventLog = new MemoryEventLog()) {
  const taskStore = new TaskStore();
  const admissions = [];
  const admissionService = {
    async admit(input) {
      admissions.push(structuredClone(input));
      const taskId = input.action.subjectRef.slice('subject:task:'.length);
      const lease = {
        leaseId: 'lease-cycle-1',
        generation: 1,
        status: 'active',
        subjectRef: `subject:task:${taskId}`,
        actionFamily: 'implement',
        successorSlot: 'implementer',
        holderCatIds: [input.holderCatIds[0]],
        holderThreadId: input.targetThreadId,
        tenantScope: 'user-1',
        terminalPredicate: { kind: 'task_done' },
      };
      return { admit: true, outcome: 'claimed', lease, fence: { leaseId: lease.leaseId, generation: 1 } };
    },
  };
  const service = new ReevalCaseResponsibilityService({
    taskStore,
    eventLog,
    admissionService,
    resolveFeatureThreadId,
    ownerUserId: 'user-1',
    now: () => '2026-08-01T01:00:00.000Z',
  });
  return { admissions, eventLog, service, taskStore };
}

const context = { systemThreadId: 'thread_eval', featureId: 'F203', evalCatId: 'gpt52' };

describe('F266 unresolved feature-thread responsibility', () => {
  it('tracks missing and ambiguous routing without creating a fallback task or lease', async () => {
    for (const reasonCode of ['feature_thread_not_found', 'feature_thread_ambiguous']) {
      const candidates = reasonCode === 'feature_thread_ambiguous' ? ['thread-a', 'thread-b'] : [];
      const { admissions, eventLog, service, taskStore } = fixture(async () => {
        throw new FeatureThreadResolutionError(reasonCode, 'F203', candidates);
      });

      const result = await service.reconcile(subject(), context);

      assert.equal(result.outcome, 'blocked');
      assert.equal(await taskStore.getBySubject(`eval-case:${caseId}:cycle:${verdictId}`), null);
      assert.equal(admissions.length, 0);
      const blocker = (await eventLog.read(caseId)).at(-1);
      assert.equal(blocker.type, 'responsibility_blocked');
      assert.equal(blocker.reasonCode, reasonCode);
      assert.equal(blocker.featureId, 'F203');
      assert.equal(blocker.ownerCatId, 'opus-47');
      assert.deepEqual(blocker.candidateThreadIds, candidates);
    }
  });

  it('binds the real feature task and lease in place once routing truth becomes unique', async () => {
    const eventLog = new MemoryEventLog();
    let targetThreadId;
    const { admissions, service, taskStore } = fixture(async () => {
      if (!targetThreadId) throw new FeatureThreadResolutionError('feature_thread_not_found', 'F203', []);
      return targetThreadId;
    }, eventLog);

    assert.equal((await service.reconcile(subject(), context)).outcome, 'blocked');
    targetThreadId = 'thread_f203';
    const recovered = await service.reconcile(subject(await eventLog.read(caseId)), context);

    assert.equal(recovered.outcome, 'bound');
    assert.equal(admissions.length, 1);
    assert.equal(admissions[0].targetThreadId, 'thread_f203');
    const task = await taskStore.getBySubject(`eval-case:${caseId}:cycle:${verdictId}`);
    assert.equal(task.threadId, 'thread_f203');
    assert.equal(task.ownerCatId, 'opus-47');
    assert.deepEqual(
      (await eventLog.read(caseId)).map((event) => event.type),
      ['verdict_cycle_observed', 'responsibility_blocked', 'responsibility_bound'],
    );
  });

  it('keeps unexpected resolver failures as scheduler failures', async () => {
    const { service } = fixture(async () => {
      throw new Error('thread store unavailable');
    });
    await assert.rejects(() => service.reconcile(subject(), context), /thread store unavailable/);
  });

  it('delivers the blocker and keeps the same case eligible for a later retry', async () => {
    const eventLog = new MemoryEventLog([observed]);
    let attempts = 0;
    const task = createReevalClosureTaskSpec({
      eventLog,
      loadSubjects: async () => [subject(await eventLog.read(caseId))],
      responsibilityService: {
        async reconcile(current) {
          attempts += 1;
          const append = await eventLog.append(
            {
              eventId: `responsibility-blocked:${verdictId}`,
              caseId,
              verdictId,
              domainId: root.domainId,
              type: 'responsibility_blocked',
              actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
              occurredAt: '2026-08-01T01:00:00.000Z',
              reason: 'feature-thread truth is unresolved',
              refs: [{ kind: 'other', availability: 'available', value: 'feature-thread-resolution:F203' }],
              reasonCode: 'feature_thread_not_found',
              featureId: 'F203',
              ownerCatId: 'opus-47',
              candidateThreadIds: [],
            },
            current.events.length,
          );
          return { outcome: 'blocked', append };
        },
      },
      now: () => '2026-08-01T01:00:00.000Z',
      log: { info() {}, warn() {} },
    });

    const first = await task.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 });
    assert.equal(first.run, true);
    await task.run.execute(first.workItems[0].signal, first.workItems[0].subjectKey, {});
    assert.equal(attempts, 1);
    assert.equal((await eventLog.read(caseId)).at(-1).type, 'responsibility_blocked');

    const retry = await task.admission.gate({ taskId: task.id, lastRunAt: Date.now(), tickCount: 2 });
    assert.equal(retry.run, true);
    assert.equal(retry.workItems[0].signal.bindResponsibility, true);
  });
});
