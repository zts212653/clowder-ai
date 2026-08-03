import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { planReevalClosureEvents } from '../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js';
import {
  createReevalClosureTaskSpec,
  loadReevalClosureSubjects,
} from '../../dist/infrastructure/harness-eval/reeval-closure-task-spec.js';

const caseId = `eval-case-v1-${'b'.repeat(64)}`;
const ref = (kind, value) => ({ kind, availability: 'available', value });
const root = {
  schemaVersion: 2,
  caseId,
  findingKey: 'rich-messaging',
  verdictId: 'week-a',
  domainId: 'eval:capability-wakeup',
  createdAt: '2026-08-01T00:00:00.000Z',
  verdict: 'fix',
  harnessUnderEval: { featureId: 'F203', componentId: 'rich-messaging', name: 'rich-messaging' },
  ownerAsk: { targetFeatureId: 'F203', targetOwnerCatId: 'codex-sol', requestedAction: 'repair activation' },
  acceptanceReevalPlan: { nextEvalAt: '2026-08-08T00:00:00.000Z', closureCondition: 'next eval passes' },
};
const observed = {
  eventId: `f266:${caseId}:cycle:week-a`,
  caseId,
  verdictId: root.verdictId,
  domainId: root.domainId,
  type: 'verdict_cycle_observed',
  actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
  occurredAt: '2026-08-01T00:01:00.000Z',
  cycleCreatedAt: root.createdAt,
  reason: 'cycle observed',
  refs: [ref('verdict', 'verdict:week-a')],
};

const lifecycleEvent = (type, overrides = {}) => ({
  eventId: `${type}:week-a`,
  caseId,
  verdictId: root.verdictId,
  domainId: root.domainId,
  type,
  actor: { kind: 'cat', id: 'codex-sol' },
  occurredAt: '2026-08-02T00:00:00.000Z',
  reason: `${type} evidence`,
  refs: [ref('message', `message:${type}`)],
  ...overrides,
});

const caseSubject = (events, roots = [root]) => ({
  caseRoot: {
    caseId,
    domainId: root.domainId,
    targetOwnerCatId: root.ownerAsk.targetOwnerCatId,
    assignedEvalCatId: 'gpt52',
    cycles: roots.map((item) => ({ verdictId: item.verdictId, createdAt: item.createdAt })),
  },
  roots,
  assignedEvalCatId: 'gpt52',
  acknowledgeHours: 48,
  events,
  openRefsByVerdictId: new Map(roots.map((item) => [item.verdictId, [ref('verdict', `verdict:${item.verdictId}`)]])),
  responsibilityContext: { systemThreadId: 'thread_eval', featureId: 'F203', evalCatId: 'gpt52' },
});

class MemoryEventLog {
  events = [];
  async append(event, expectedSequence) {
    if (this.events.some((item) => item.eventId === event.eventId)) return { outcome: 'duplicate' };
    if (this.events.length !== expectedSequence) return { outcome: 'conflict', actualSequence: this.events.length };
    this.events.push(structuredClone(event));
    return { outcome: 'appended', sequence: expectedSequence };
  }
  async read(subjectId) {
    return subjectId === caseId ? structuredClone(this.events) : [];
  }
  async listVerdictIds() {
    return this.events.length ? [caseId] : [];
  }
  async listSubjectIds() {
    return this.listVerdictIds();
  }
}

describe('F266 stable case reconciler', () => {
  it('groups repeated v2 roots and observes each cycle in one stream', async (t) => {
    const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'f266-case-subjects-'));
    t.after(() => rmSync(harnessFeedbackRoot, { recursive: true, force: true }));
    const second = { ...root, verdictId: 'week-b', createdAt: '2026-08-08T00:00:00.000Z' };
    for (const item of [root, second]) {
      const bundle = join(harnessFeedbackRoot, 'bundles', item.verdictId);
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, 'lifecycle-root.json'), JSON.stringify(item));
    }
    mkdirSync(join(harnessFeedbackRoot, 'eval-domains'), { recursive: true });
    writeFileSync(
      join(harnessFeedbackRoot, 'eval-domains', 'eval-capability-wakeup.yaml'),
      `domainId: eval:capability-wakeup\ndisplayName: Wakeup\nsystemThreadId: thread_eval\nevalCat: { catId: gpt52, handle: "@gpt52", model: gpt-5.4 }\nfrequency: weekly\nsourceAdapter: wakeup\nsourceRefsKind: window\nthreadPolicy: { role: working-home, stateSot: registry, allowedContent: [verdict-discussion] }\nlegacyScheduledTaskIds: []\nhandoffTargetResolver: { featureId: F203, ownerCatId: codex-sol, threadLookup: feature-thread }\nsla: { acknowledgeHours: 48, reevalWithinHours: 168 }\nfixtures: []\n`,
    );
    const eventLog = new MemoryEventLog();
    const subjects = await loadReevalClosureSubjects({ harnessFeedbackRoot, eventLog });
    assert.equal(subjects.length, 1);
    assert.deepEqual(
      subjects[0].caseRoot.cycles.map((cycle) => cycle.verdictId),
      ['week-a', 'week-b'],
    );
    const planned = planReevalClosureEvents(subjects[0], '2026-08-08T01:00:00.000Z');
    assert.deepEqual(
      planned.map((item) => item.event.type),
      ['verdict_cycle_observed', 'verdict_cycle_observed', 'sla_escalated'],
    );
    assert.ok(planned.every((item) => item.event.caseId === caseId));
  });

  it('resurfaces overdue acknowledgement and re-evaluation', () => {
    const acknowledgement = planReevalClosureEvents(caseSubject([observed]), '2026-08-03T00:00:00.000Z');
    assert.equal(acknowledgement[0].event.stage, 'acknowledgement');
    const pending = [
      observed,
      lifecycleEvent('responsibility_bound', {
        actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
        taskId: 'task-week-a',
        leaseId: 'lease-week-a',
        leaseGeneration: 1,
      }),
      lifecycleEvent('action_planned'),
      lifecycleEvent('main_landed', { commitSha: 'a'.repeat(40) }),
      lifecycleEvent('live_active', { commitSha: 'a'.repeat(40) }),
      lifecycleEvent('reeval_requested', { dueAt: '2026-08-10T00:00:00.000Z', assignedEvalCatId: 'gpt52' }),
    ];
    const reevaluation = planReevalClosureEvents(caseSubject(pending), '2026-08-10T00:00:00.000Z');
    assert.equal(reevaluation[0].event.stage, 'reevaluation');
    assert.equal(reevaluation[0].event.caseId, caseId);
  });

  it('runs observation then durable responsibility binding once across restart', async () => {
    const eventLog = new MemoryEventLog();
    const loadSubjects = async () => [caseSubject(await eventLog.read(caseId))];
    let bindings = 0;
    const responsibilityService = {
      async reconcile(subject) {
        bindings += 1;
        assert.deepEqual(
          subject.events.map((item) => item.type),
          ['verdict_cycle_observed'],
        );
        await eventLog.append(
          lifecycleEvent('responsibility_bound', {
            actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
            taskId: 'task-week-a',
            leaseId: 'lease-week-a',
            leaseGeneration: 1,
          }),
          subject.events.length,
        );
      },
    };
    const options = {
      eventLog,
      loadSubjects,
      responsibilityService,
      now: () => '2026-08-01T01:00:00.000Z',
      log: { info() {}, warn() {} },
    };
    const task = createReevalClosureTaskSpec(options);
    const gate = await task.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gate.run, true);
    await task.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(bindings, 1);
    const restarted = createReevalClosureTaskSpec(options);
    assert.equal((await restarted.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 })).run, false);
  });

  it('binds fresh responsibility after an absorbed actionable cycle becomes active', async () => {
    const second = { ...root, verdictId: 'week-b', createdAt: '2026-08-08T00:00:00.000Z' };
    const pending = [
      observed,
      lifecycleEvent('responsibility_bound', {
        actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
        taskId: 'task-week-a',
        leaseId: 'lease-week-a',
        leaseGeneration: 1,
      }),
      lifecycleEvent('action_planned'),
      lifecycleEvent('main_landed', { commitSha: 'a'.repeat(40) }),
      lifecycleEvent('live_active', { commitSha: 'a'.repeat(40) }),
      lifecycleEvent('reeval_requested', {
        dueAt: '2026-08-10T00:00:00.000Z',
        assignedEvalCatId: 'gpt52',
      }),
      {
        ...observed,
        eventId: `f266:${caseId}:cycle:week-b`,
        verdictId: 'week-b',
        occurredAt: '2026-08-08T00:01:00.000Z',
        cycleCreatedAt: '2026-08-08T00:00:00.000Z',
      },
      lifecycleEvent('reeval_passed', {
        actor: { kind: 'cat', id: 'gpt52' },
        occurredAt: '2026-08-09T00:00:00.000Z',
        assignedEvalCatId: 'gpt52',
      }),
    ];
    const current = caseSubject(pending, [root, second]);
    let bindings = 0;
    const task = createReevalClosureTaskSpec({
      eventLog: new MemoryEventLog(),
      loadSubjects: async () => [current],
      responsibilityService: {
        async reconcile(subject) {
          bindings += 1;
          assert.equal(subject.caseRoot.caseId, caseId);
        },
      },
      now: () => '2026-08-09T01:00:00.000Z',
      log: { info() {}, warn() {} },
    });

    const gate = await task.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 });
    assert.equal(gate.run, true);
    assert.deepEqual(gate.workItems[0].signal.planned, []);
    assert.equal(gate.workItems[0].signal.bindResponsibility, true);
    await task.run.execute(gate.workItems[0].signal, gate.workItems[0].subjectKey, {});
    assert.equal(bindings, 1);
  });

  it('treats a first keep-observe cycle as no work instead of projecting an empty case stream', async () => {
    const eventLog = new MemoryEventLog();
    const observing = { ...root, verdict: 'keep_observe' };
    const task = createReevalClosureTaskSpec({
      eventLog,
      loadSubjects: async () => [caseSubject([], [observing])],
      responsibilityService: {
        async reconcile() {
          throw new Error('must not bind');
        },
      },
      now: () => '2026-08-01T01:00:00.000Z',
      log: { info() {}, warn() {} },
    });

    const gate = await task.admission.gate({ taskId: task.id, lastRunAt: null, tickCount: 1 });
    assert.deepEqual(gate, { run: false, reason: 'no lifecycle events due' });
  });
});
