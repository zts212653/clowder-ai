import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  projectReevalClosure,
  ReevalClosureProjectionError,
} from '../../dist/infrastructure/harness-eval/reeval-closure.js';
import { EvalLifecycleEventSchema } from '../../dist/infrastructure/harness-eval/reeval-closure-schema.js';

const root = {
  verdictId: '2026-07-12-capability-wakeup-workspace-navigator-cognitive-fix',
  domainId: 'eval:capability-wakeup',
  targetOwnerCatId: 'codex-sol',
  assignedEvalCatId: 'gpt52',
};

const availableRef = (kind, value) => ({ kind, availability: 'available', value });
const unavailableRef = (kind, unavailableReason) => ({
  kind,
  availability: 'unavailable',
  unavailableReason,
});

let eventSequence = 0;

function lifecycleEvent(type, overrides = {}) {
  eventSequence += 1;
  const actors = {
    verdict_opened: { kind: 'migration', id: 'f266-backfill' },
    owner_reassigned: { kind: 'cvo', id: 'you' },
    owner_acknowledged: { kind: 'cat', id: 'codex-sol' },
    action_planned: { kind: 'cat', id: 'codex-sol' },
    fix_recorded: { kind: 'cat', id: 'codex-sol' },
    reeval_requested: { kind: 'cat', id: 'codex-sol' },
    reeval_passed: { kind: 'cat', id: 'gpt52' },
    reeval_failed: { kind: 'cat', id: 'gpt52' },
    cvo_suppressed: { kind: 'cvo', id: 'you' },
    sla_escalated: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
  };

  return {
    eventId: `evt-${eventSequence}`,
    verdictId: root.verdictId,
    domainId: root.domainId,
    type,
    actor: actors[type],
    occurredAt: new Date(Date.parse('2026-07-18T00:00:00.000Z') + eventSequence * 60_000).toISOString(),
    reason: `${type} evidence`,
    refs: [availableRef('message', `thread:message-${eventSequence}`)],
    ...(['reeval_requested', 'reeval_passed', 'reeval_failed'].includes(type) ? { assignedEvalCatId: 'gpt52' } : {}),
    ...overrides,
  };
}

function opened(overrides = {}) {
  return lifecycleEvent('verdict_opened', {
    refs: [availableRef('verdict', `docs/harness-feedback/verdicts/${root.verdictId}.md`)],
    ...overrides,
  });
}

function throughReevalPending() {
  return [
    opened(),
    lifecycleEvent('owner_acknowledged'),
    lifecycleEvent('action_planned', { refs: [availableRef('plan', 'task:f266-fix')] }),
    lifecycleEvent('fix_recorded', { refs: [availableRef('commit', '50ec90163')] }),
    lifecycleEvent('reeval_requested', {
      dueAt: '2026-07-19T03:00:00.000Z',
      refs: [availableRef('reeval', 'eval:capability-wakeup:2026-07-19')],
    }),
  ];
}

describe('eval verdict lifecycle schema', () => {
  it('accepts available and explicitly unavailable evidence refs', () => {
    const result = EvalLifecycleEventSchema.safeParse(
      opened({
        refs: [
          availableRef('verdict', 'docs/harness-feedback/verdicts/example.md'),
          unavailableRef('message', 'historical message identity was not archived'),
        ],
      }),
    );

    assert.equal(result.success, true);
  });

  it('rejects empty reasons, empty refs, malformed refs, actor overrides, and unknown verbs', () => {
    const valid = opened();
    const invalidEvents = [
      { ...valid, reason: '' },
      { ...valid, refs: [] },
      { ...valid, refs: [{ kind: 'verdict', availability: 'available' }] },
      { ...valid, refs: [{ kind: 'message', availability: 'unavailable' }] },
      { ...valid, actorOverride: { kind: 'cvo', id: 'spoofed' } },
      { ...valid, type: 'merge_fix_and_resolve' },
      lifecycleEvent('reeval_passed', { assignedEvalCatId: undefined }),
    ];

    for (const event of invalidEvents) {
      assert.equal(EvalLifecycleEventSchema.safeParse(event).success, false);
    }
  });
});

describe('eval verdict lifecycle projection', () => {
  it('folds the canonical fix plus re-eval path without treating a fix ref as terminal', () => {
    const events = throughReevalPending();
    const statuses = events.map((_, index) => projectReevalClosure(root, events.slice(0, index + 1)).status);

    assert.deepEqual(statuses, ['open', 'acknowledged', 'action_planned', 'fix_landed', 'reeval_pending']);

    const fixed = projectReevalClosure(root, events.slice(0, 4));
    assert.equal(fixed.status, 'fix_landed');
    assert.equal(fixed.actionRefs[0].value, '50ec90163');

    const resolved = projectReevalClosure(root, [
      ...events,
      lifecycleEvent('reeval_passed', {
        refs: [availableRef('reeval', 'docs/harness-feedback/verdicts/2026-07-19-reeval.md')],
      }),
    ]);

    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.reevalRefs.at(-1).value, 'docs/harness-feedback/verdicts/2026-07-19-reeval.md');
  });

  it('allows only operator evidence to create a reasoned suppression terminal', () => {
    const suppressed = projectReevalClosure(root, [
      opened(),
      lifecycleEvent('cvo_suppressed', {
        reason: 'operator accepts the measured tradeoff for this harness behavior',
        refs: [availableRef('message', 'thread:cvo-suppression')],
      }),
    ]);

    assert.equal(suppressed.status, 'suppressed_with_reason');
    assert.match(suppressed.closureReason, /measured tradeoff/);

    assert.throws(
      () =>
        projectReevalClosure(root, [
          opened(),
          lifecycleEvent('cvo_suppressed', { actor: { kind: 'cat', id: 'codex-sol' } }),
        ]),
      ReevalClosureProjectionError,
    );
  });

  it('keeps SLA escalation visible but recoverable for both acknowledgement and re-evaluation', () => {
    const acknowledgementEscalation = [
      opened(),
      lifecycleEvent('sla_escalated', {
        stage: 'acknowledgement',
        dueAt: '2026-07-18T12:00:00.000Z',
        refs: [availableRef('sla', 'sla:acknowledgement:2026-07-18T12:00:00.000Z')],
      }),
    ];
    assert.equal(projectReevalClosure(root, acknowledgementEscalation).status, 'escalated');
    assert.equal(
      projectReevalClosure(root, [...acknowledgementEscalation, lifecycleEvent('owner_acknowledged')]).status,
      'acknowledged',
    );

    const reevalEscalation = [
      ...throughReevalPending(),
      lifecycleEvent('sla_escalated', {
        stage: 'reevaluation',
        dueAt: '2026-07-19T03:00:00.000Z',
        refs: [availableRef('sla', 'sla:reevaluation:2026-07-19T03:00:00.000Z')],
      }),
    ];
    assert.equal(projectReevalClosure(root, reevalEscalation).status, 'escalated');
    const resolved = projectReevalClosure(root, [...reevalEscalation, lifecycleEvent('reeval_passed')]);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.reevalDueAt, undefined);
    assert.equal(resolved.escalation, undefined);

    const retrying = projectReevalClosure(root, [...reevalEscalation, lifecycleEvent('reeval_failed')]);
    assert.equal(retrying.status, 'action_planned');
    assert.equal(retrying.reevalDueAt, undefined);
    assert.equal(retrying.escalation, undefined);
  });

  it('materializes only explicitly unavailable historical eval authority from the first verified result', () => {
    const pending = throughReevalPending();
    const unpinnedRequest = { ...pending.at(-1), assignedEvalCatId: undefined };
    assert.throws(
      () => projectReevalClosure(root, [...pending.slice(0, -1), unpinnedRequest]),
      /explicitly unavailable authority evidence/,
    );
    pending[pending.length - 1] = {
      ...unpinnedRequest,
      refs: [unavailableRef('reeval', 'historical trusted eval principal was unavailable')],
    };
    const passed = lifecycleEvent('reeval_passed', { assignedEvalCatId: 'gpt52' });
    const history = [...pending, passed];

    const projection = projectReevalClosure({ ...root, assignedEvalCatId: 'future-eval' }, history);
    assert.equal(projection.status, 'resolved');
    assert.equal(projection.reevalAssignedCatId, 'gpt52');
    assert.equal(
      projectReevalClosure({ ...root, assignedEvalCatId: 'another-future-eval' }, history).status,
      'resolved',
    );

    assert.throws(
      () =>
        projectReevalClosure(root, [
          ...throughReevalPending(),
          lifecycleEvent('reeval_passed', {
            actor: { kind: 'cat', id: 'future-eval' },
            assignedEvalCatId: 'future-eval',
          }),
        ]),
      /pinned principal gpt52/,
    );
  });

  it('enforces owner continuity until an audited reassignment event', () => {
    const acknowledged = [opened(), lifecycleEvent('owner_acknowledged')];

    assert.throws(
      () =>
        projectReevalClosure(root, [
          ...acknowledged,
          lifecycleEvent('action_planned', { actor: { kind: 'cat', id: 'opus' } }),
        ]),
      /active lifecycle owner/,
    );

    const reassigned = projectReevalClosure(root, [
      ...acknowledged,
      lifecycleEvent('owner_reassigned', {
        targetOwnerCatId: 'opus',
        refs: [availableRef('message', 'thread:audited-handoff')],
      }),
      lifecycleEvent('action_planned', { actor: { kind: 'cat', id: 'opus' } }),
    ]);

    assert.equal(reassigned.targetOwnerCatId, 'opus');
    assert.equal(reassigned.lifecycleOwnerCatId, 'opus');
    assert.equal(reassigned.status, 'action_planned');
  });

  it('rejects malformed replay history and any event after a terminal', () => {
    assert.throws(() => projectReevalClosure(root, [lifecycleEvent('owner_acknowledged')]), /first event/);
    assert.throws(
      () => projectReevalClosure(root, [opened({ actor: { kind: 'cat', id: 'codex-sol' } })]),
      /publisher automation or migration/,
    );
    assert.throws(() => projectReevalClosure({ ...root, assignedEvalCatId: '' }, [opened()]), /assignedEvalCatId/);
    assert.throws(() => projectReevalClosure(root, [opened(), opened()]), /verdict_opened/);
    assert.throws(() => projectReevalClosure(root, [opened(), lifecycleEvent('action_planned')]), /illegal transition/);
    assert.throws(
      () => projectReevalClosure(root, [opened(), lifecycleEvent('owner_acknowledged', { verdictId: 'other' })]),
      /verdictId/,
    );

    const terminal = [opened(), lifecycleEvent('cvo_suppressed')];
    assert.throws(
      () => projectReevalClosure(root, [...terminal, lifecycleEvent('owner_reassigned', { targetOwnerCatId: 'opus' })]),
      /terminal/,
    );
  });

  it('preserves unavailable historical segments and does not branch on domain id', () => {
    const historical = projectReevalClosure(root, [
      opened({ refs: [unavailableRef('message', 'source message predates durable lifecycle capture')] }),
    ]);
    assert.deepEqual(
      historical.refs[0],
      unavailableRef('message', 'source message predates durable lifecycle capture'),
    );

    const genericRoot = {
      ...root,
      verdictId: '2026-07-18-capability-tips-synthetic',
      domainId: 'eval:capability-tips',
    };
    const genericOpen = opened({ verdictId: genericRoot.verdictId, domainId: genericRoot.domainId });
    const genericProjection = projectReevalClosure(genericRoot, [genericOpen]);

    assert.equal(genericProjection.domainId, 'eval:capability-tips');
    assert.equal(genericProjection.status, 'open');
  });
});
