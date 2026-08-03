import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID } from '../../dist/infrastructure/harness-eval/capability-wakeup-closure-import.js';
import { planReevalClosureEvents } from '../../dist/infrastructure/harness-eval/reeval-closure-reconciler.js';
import {
  createReevalClosureTaskSpec,
  loadReevalClosureSubjects,
} from '../../dist/infrastructure/harness-eval/reeval-closure-task-spec.js';

const availableRef = (kind, value) => ({ kind, availability: 'available', value });

function lifecycleRoot(overrides = {}) {
  return {
    schemaVersion: 1,
    verdictId: 'synthetic-capability-tips-verdict',
    domainId: 'eval:capability-tips',
    createdAt: '2026-07-18T00:00:00.000Z',
    verdict: 'fix',
    harnessUnderEval: { featureId: 'F268', componentId: 'tips', name: 'capability-tips' },
    ownerAsk: {
      targetFeatureId: 'F268',
      targetOwnerCatId: 'codex-sol',
      requestedAction: 'repair the generic capability tip',
    },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-07-25T00:00:00.000Z',
      closureCondition: 'the next eval verifies the repaired behavior',
    },
    ...overrides,
  };
}

function subject(overrides = {}) {
  const root = overrides.root ?? lifecycleRoot();
  return {
    root,
    assignedEvalCatId: 'gpt52',
    acknowledgeHours: 48,
    events: [],
    openRefs: [
      availableRef('verdict', `docs/harness-feedback/verdicts/${root.verdictId}.md`),
      availableRef('other', `docs/harness-feedback/bundles/${root.verdictId}/lifecycle-root.json`),
    ],
    ...overrides,
  };
}

let sequence = 0;

function event(root, type, overrides = {}) {
  sequence += 1;
  return {
    eventId: `fixture-${sequence}`,
    verdictId: root.verdictId,
    domainId: root.domainId,
    type,
    actor: { kind: 'cat', id: 'codex-sol' },
    occurredAt: new Date(Date.parse(root.createdAt) + sequence * 60_000).toISOString(),
    reason: `${type} fixture evidence`,
    refs: [availableRef('message', `thread:fixture-${sequence}`)],
    ...(['reeval_requested', 'reeval_passed', 'reeval_failed'].includes(type) ? { assignedEvalCatId: 'gpt52' } : {}),
    ...overrides,
  };
}

function throughReevalPending(root) {
  return [
    event(root, 'verdict_opened', {
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      refs: [availableRef('verdict', `docs/harness-feedback/verdicts/${root.verdictId}.md`)],
    }),
    event(root, 'owner_acknowledged'),
    event(root, 'action_planned'),
    event(root, 'fix_recorded', { refs: [availableRef('commit', 'fix-commit')] }),
    event(root, 'reeval_requested', {
      dueAt: '2026-07-20T00:00:00.000Z',
      refs: [availableRef('reeval', 'eval:synthetic:2026-07-20')],
    }),
  ];
}

class MemoryEventLog {
  events = new Map();
  seen = new Set();

  async append(lifecycleEvent, expectedSequence) {
    if (this.seen.has(lifecycleEvent.eventId)) return { outcome: 'duplicate' };
    const subjectId = lifecycleEvent.caseId ?? lifecycleEvent.verdictId;
    const existing = this.events.get(subjectId) ?? [];
    if (existing.length !== expectedSequence) return { outcome: 'conflict', actualSequence: existing.length };
    this.seen.add(lifecycleEvent.eventId);
    this.events.set(subjectId, [...existing, structuredClone(lifecycleEvent)]);
    return { outcome: 'appended', sequence: existing.length };
  }

  async read(verdictId) {
    return structuredClone(this.events.get(verdictId) ?? []);
  }

  async listVerdictIds() {
    return [...this.events.keys()].sort();
  }

  async listSubjectIds() {
    return this.listVerdictIds();
  }
}

describe('eval verdict lifecycle reconciler', () => {
  it('loads the historical case only from a root that contains its verdict and registered domain', async (t) => {
    const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'f266-closure-subjects-'));
    t.after(() => rmSync(harnessFeedbackRoot, { recursive: true, force: true }));
    const eventLog = new MemoryEventLog();

    assert.deepEqual(await loadReevalClosureSubjects({ harnessFeedbackRoot, eventLog }), []);

    mkdirSync(join(harnessFeedbackRoot, 'verdicts'));
    mkdirSync(join(harnessFeedbackRoot, 'eval-domains'));
    writeFileSync(
      join(harnessFeedbackRoot, 'verdicts', `${CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID}.md`),
      '# historical verdict evidence\n',
    );
    writeFileSync(
      join(harnessFeedbackRoot, 'eval-domains', 'eval-capability-wakeup.yaml'),
      `domainId: eval:capability-wakeup
displayName: Capability Wakeup Eval
systemThreadId: thread_eval_capability_wakeup
evalCat:
  catId: opus-47
  handle: "@opus47"
  model: claude-opus-4-7
frequency: weekly
sourceAdapter: capability-wakeup-eval
sourceRefsKind: capability-wakeup-trial-window
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent: [longitudinal-analysis]
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F203
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
fixtures: []
`,
    );

    const subjects = await loadReevalClosureSubjects({
      harnessFeedbackRoot,
      eventLog,
      resolveAssignedEvalCatId: async () => 'override-eval',
    });
    assert.equal(subjects.length, 1);
    assert.equal(subjects[0].root.verdictId, CAPABILITY_WAKEUP_HISTORICAL_VERDICT_ID);
    assert.equal(subjects[0].assignedEvalCatId, 'override-eval');
    assert.deepEqual(
      subjects[0].bootstrapEvents.map((lifecycleEvent) => lifecycleEvent.type),
      ['verdict_opened', 'owner_acknowledged', 'action_planned', 'fix_recorded', 'reeval_requested'],
    );
  });

  it('opens every actionable domain generically and leaves keep_observe without a record', () => {
    const actionable = subject();
    const planned = planReevalClosureEvents(actionable, '2026-07-18T01:00:00.000Z');
    assert.equal(planned.length, 1);
    assert.equal(planned[0].event.type, 'verdict_opened');
    assert.equal(planned[0].event.domainId, 'eval:capability-tips');
    assert.equal(planned[0].expectedSequence, 0);

    const observing = subject({ root: lifecycleRoot({ verdict: 'keep_observe' }) });
    assert.deepEqual(planReevalClosureEvents(observing, '2026-08-01T00:00:00.000Z'), []);
  });

  it('plans one deterministic recoverable acknowledgement escalation after the due time', () => {
    const overdue = subject({ acknowledgeHours: 24 });
    const firstPlan = planReevalClosureEvents(overdue, '2026-07-20T00:00:00.000Z');
    const retryPlan = planReevalClosureEvents(overdue, '2026-07-21T00:00:00.000Z');

    assert.deepEqual(
      firstPlan.map((item) => item.event.type),
      ['verdict_opened', 'sla_escalated'],
    );
    assert.equal(firstPlan[1].event.stage, 'acknowledgement');
    assert.equal(firstPlan[1].expectedSequence, 1);
    assert.deepEqual(
      firstPlan.map((item) => item.event.eventId),
      retryPlan.map((item) => item.event.eventId),
      'repeated ticks must use the same event identities',
    );
  });

  it('escalates a missed re-evaluation once and stops after result or active work moves state', () => {
    const root = lifecycleRoot();
    const pending = throughReevalPending(root);
    const planned = planReevalClosureEvents(subject({ root, events: pending }), '2026-07-21T00:00:00.000Z');

    assert.equal(planned.length, 1);
    assert.equal(planned[0].event.type, 'sla_escalated');
    assert.equal(planned[0].event.stage, 'reevaluation');
    assert.equal(
      planReevalClosureEvents(subject({ root, events: [...pending, planned[0].event] }), '2026-07-22T00:00:00.000Z')
        .length,
      0,
    );

    const acknowledgedOnly = pending.slice(0, 2);
    assert.equal(
      planReevalClosureEvents(subject({ root, events: acknowledgedOnly }), '2026-08-01T00:00:00.000Z').length,
      0,
    );

    const resolved = [
      ...pending,
      event(root, 'reeval_passed', { actor: { kind: 'cat', id: 'gpt52' }, refs: [availableRef('reeval', 'pass')] }),
    ];
    assert.equal(planReevalClosureEvents(subject({ root, events: resolved }), '2026-08-01T00:00:00.000Z').length, 0);
  });

  it('TaskRunner wrapper remains idempotent across repeated gates and a new instance', async () => {
    const eventLog = new MemoryEventLog();
    const template = subject({ acknowledgeHours: 24 });
    const loadSubjects = async () => [{ ...template, events: await eventLog.read(template.root.verdictId) }];
    const options = {
      eventLog,
      loadSubjects,
      now: () => '2026-07-20T00:00:00.000Z',
      log: { info() {}, warn() {} },
    };
    const firstTask = createReevalClosureTaskSpec(options);
    const firstGate = await firstTask.admission.gate({ taskId: firstTask.id, lastRunAt: null, tickCount: 1 });
    assert.equal(firstGate.run, true);
    await firstTask.run.execute(firstGate.workItems[0].signal, firstGate.workItems[0].subjectKey, {});
    assert.equal((await eventLog.read(template.root.verdictId)).length, 2);
    assert.equal((await firstTask.admission.gate({ taskId: firstTask.id, lastRunAt: null, tickCount: 2 })).run, false);

    const restartedTask = createReevalClosureTaskSpec(options);
    assert.equal(
      (await restartedTask.admission.gate({ taskId: restartedTask.id, lastRunAt: null, tickCount: 1 })).run,
      false,
    );
  });
});
