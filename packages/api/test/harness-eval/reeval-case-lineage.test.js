import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { projectReevalCase } from '../../dist/infrastructure/harness-eval/reeval-case.js';
import { ReevalClosureProjectionError } from '../../dist/infrastructure/harness-eval/reeval-closure.js';
import { EvalLifecycleEventSchema } from '../../dist/infrastructure/harness-eval/reeval-closure-schema.js';

const caseId = 'eval-case-v1-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const domainId = 'eval:capability-wakeup';
const firstVerdictId = 'capability-wakeup-2026-08-01-rich-messaging';
const secondVerdictId = 'capability-wakeup-2026-08-08-rich-messaging';

const root = {
  caseId,
  domainId,
  targetOwnerCatId: 'codex-sol',
  assignedEvalCatId: 'gpt52',
  cycles: [
    { verdictId: firstVerdictId, createdAt: '2026-08-01T00:00:00.000Z', verdict: 'fix' },
    { verdictId: secondVerdictId, createdAt: '2026-08-08T00:00:00.000Z', verdict: 'fix' },
  ],
};

const ref = (kind, value) => ({ kind, availability: 'available', value });

function event(type, overrides = {}) {
  const actors = {
    verdict_cycle_observed: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
    responsibility_bound: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
    action_planned: { kind: 'cat', id: 'codex-sol' },
    main_landed: { kind: 'cat', id: 'codex-sol' },
    live_active: { kind: 'cat', id: 'codex-sol' },
    reeval_requested: { kind: 'cat', id: 'codex-sol' },
    reeval_passed: { kind: 'cat', id: 'gpt52' },
    reeval_failed: { kind: 'cat', id: 'gpt52' },
  };
  const verdictId = overrides.verdictId ?? firstVerdictId;
  return {
    eventId: `${type}-${verdictId}`,
    caseId,
    verdictId,
    domainId,
    type,
    actor: actors[type],
    occurredAt: overrides.occurredAt ?? '2026-08-01T01:00:00.000Z',
    reason: `${type} evidence`,
    refs: [ref('verdict', `docs/harness-feedback/verdicts/${verdictId}.md`)],
    ...(type === 'verdict_cycle_observed'
      ? { cycleCreatedAt: overrides.cycleCreatedAt ?? '2026-08-01T00:00:00.000Z' }
      : {}),
    ...(type === 'responsibility_bound'
      ? { taskId: 'task-cycle-1', leaseId: 'lease-cycle-1', leaseGeneration: 1 }
      : {}),
    ...(['main_landed', 'live_active'].includes(type) ? { commitSha: 'a'.repeat(40) } : {}),
    ...(type === 'reeval_requested' ? { dueAt: '2026-08-08T00:00:00.000Z', assignedEvalCatId: 'gpt52' } : {}),
    ...(['reeval_passed', 'reeval_failed'].includes(type) ? { assignedEvalCatId: 'gpt52' } : {}),
    ...overrides,
  };
}

function throughPending() {
  return [
    event('verdict_cycle_observed'),
    event('responsibility_bound', { refs: [ref('task', 'task-cycle-1'), ref('other', 'lease:lease-cycle-1:1')] }),
    event('action_planned', { refs: [ref('plan', 'task:task-cycle-1')] }),
    event('main_landed', { refs: [ref('commit', 'a'.repeat(40))] }),
    event('live_active', { refs: [ref('commit', 'a'.repeat(40))] }),
    event('reeval_requested', { refs: [ref('reeval', 'eval:capability-wakeup:2026-08-08')] }),
  ];
}

describe('F266 stable case lifecycle', () => {
  it('requires main and live as separate ordered facts before re-evaluation', () => {
    const events = throughPending();
    const statuses = events.map((_, index) => projectReevalCase(root, events.slice(0, index + 1)).status);

    assert.deepEqual(statuses, [
      'open',
      'acknowledged',
      'action_planned',
      'main_landed',
      'live_active',
      'reeval_pending',
    ]);
    const pending = projectReevalCase(root, events);
    assert.equal(pending.mainCommitSha, 'a'.repeat(40));
    assert.equal(pending.liveCommitSha, 'a'.repeat(40));
    assert.equal(pending.taskId, 'task-cycle-1');
    assert.equal(pending.leaseId, 'lease-cycle-1');

    assert.throws(
      () => projectReevalCase(root, [...events.slice(0, 4), event('reeval_requested')]),
      /illegal transition/,
    );
    assert.throws(
      () => projectReevalCase(root, [...events.slice(0, 4), event('live_active', { commitSha: 'b'.repeat(40) })]),
      /same main commit/,
    );
  });

  it('absorbs another weekly verdict into the active case without minting parallel responsibility', () => {
    const active = throughPending();
    const observed = event('verdict_cycle_observed', {
      eventId: 'observe-cycle-2',
      verdictId: secondVerdictId,
      cycleCreatedAt: '2026-08-08T00:00:00.000Z',
      occurredAt: '2026-08-08T00:01:00.000Z',
    });
    const projection = projectReevalCase(root, [...active, observed]);

    assert.equal(projection.status, 'reeval_pending');
    assert.equal(projection.activeVerdictId, firstVerdictId);
    assert.deepEqual(projection.observedVerdictIds, [firstVerdictId, secondVerdictId]);
    assert.equal(projection.taskId, 'task-cycle-1');
    assert.equal(projection.leaseId, 'lease-cycle-1');
  });

  it('promotes an absorbed actionable cycle when the active cycle reaches terminal re-evaluation', () => {
    const active = throughPending();
    const observed = event('verdict_cycle_observed', {
      eventId: 'observe-cycle-2',
      verdictId: secondVerdictId,
      cycleCreatedAt: '2026-08-08T00:00:00.000Z',
      occurredAt: '2026-08-08T00:01:00.000Z',
    });
    const resolved = event('reeval_passed', {
      occurredAt: '2026-08-09T00:00:00.000Z',
    });
    const projection = projectReevalCase(root, [...active, observed, resolved]);

    assert.equal(projection.status, 'open');
    assert.equal(projection.activeVerdictId, secondVerdictId);
    assert.deepEqual(projection.observedVerdictIds, [firstVerdictId, secondVerdictId]);
    assert.equal(projection.taskId, undefined);
    assert.equal(projection.leaseId, undefined);
    assert.equal(projection.mainCommitSha, undefined);
    assert.equal(projection.liveCommitSha, undefined);
    assert.deepEqual(projection.planRefs, []);
    assert.deepEqual(projection.actionRefs, []);
    assert.deepEqual(projection.reevalRefs, []);
  });

  it('does not promote an absorbed keep-observe cycle after actionable closure', () => {
    const keepObserveRoot = {
      ...root,
      cycles: [root.cycles[0], { ...root.cycles[1], verdict: 'keep_observe' }],
    };
    const observed = event('verdict_cycle_observed', {
      eventId: 'observe-cycle-2',
      verdictId: secondVerdictId,
      cycleCreatedAt: '2026-08-08T00:00:00.000Z',
      occurredAt: '2026-08-08T00:01:00.000Z',
    });
    const projection = projectReevalCase(keepObserveRoot, [
      ...throughPending(),
      observed,
      event('reeval_passed', { occurredAt: '2026-08-09T00:00:00.000Z' }),
    ]);

    assert.equal(projection.status, 'resolved');
    assert.equal(projection.activeVerdictId, firstVerdictId);
  });

  it('reopens the same stable case only for a genuinely later cycle after terminal re-evaluation', () => {
    const resolvedAt = '2026-08-08T01:00:00.000Z';
    const terminal = [...throughPending(), event('reeval_passed', { occurredAt: resolvedAt })];
    const lateCycle = event('verdict_cycle_observed', {
      eventId: 'observe-cycle-2',
      verdictId: secondVerdictId,
      cycleCreatedAt: '2026-08-15T00:00:00.000Z',
      occurredAt: '2026-08-15T00:01:00.000Z',
    });
    const reopened = projectReevalCase(
      {
        ...root,
        cycles: [root.cycles[0], { verdictId: secondVerdictId, createdAt: '2026-08-15T00:00:00.000Z', verdict: 'fix' }],
      },
      [...terminal, lateCycle],
    );

    assert.equal(reopened.caseId, caseId);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.activeVerdictId, secondVerdictId);
    assert.equal(reopened.taskId, undefined);
    assert.equal(reopened.mainCommitSha, undefined);
    assert.equal(reopened.liveCommitSha, undefined);

    const staleCycle = { ...lateCycle, cycleCreatedAt: '2026-07-25T00:00:00.000Z' };
    const staleRoot = {
      ...root,
      cycles: [root.cycles[0], { verdictId: secondVerdictId, createdAt: '2026-07-25T00:00:00.000Z', verdict: 'fix' }],
    };
    assert.equal(projectReevalCase(staleRoot, [...terminal, staleCycle]).status, 'resolved');
  });

  it('rejects foreign case/cycle identity and malformed binding evidence', () => {
    assert.equal(EvalLifecycleEventSchema.safeParse(event('verdict_cycle_observed')).success, true);
    assert.equal(EvalLifecycleEventSchema.safeParse(event('responsibility_bound')).success, true);
    assert.throws(
      () => projectReevalCase(root, [event('verdict_cycle_observed', { caseId: `eval-case-v1-${'b'.repeat(64)}` })]),
      ReevalClosureProjectionError,
    );
    assert.throws(
      () => projectReevalCase(root, [event('verdict_cycle_observed', { verdictId: 'unregistered-cycle' })]),
      ReevalClosureProjectionError,
    );
    assert.equal(
      EvalLifecycleEventSchema.safeParse(event('responsibility_bound', { leaseGeneration: 0 })).success,
      false,
    );
  });
});
