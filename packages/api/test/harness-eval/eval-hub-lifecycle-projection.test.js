import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { enrichEvalHubLifecycle } from '../../dist/infrastructure/harness-eval/hub/eval-hub-lifecycle-projection.js';

const verdictId = 'f266-projection-verdict';

function availableRef(kind, value) {
  return { kind, availability: 'available', value };
}

function lifecycleEvent(event) {
  return { verdictId, domainId: 'eval:capability-tips', ...event };
}

function setupRoot(t) {
  const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'f266-hub-lifecycle-'));
  t.after(() => rmSync(harnessFeedbackRoot, { recursive: true, force: true }));
  const bundleDir = join(harnessFeedbackRoot, 'bundles', verdictId);
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(join(harnessFeedbackRoot, 'eval-domains'), { recursive: true });
  writeFileSync(
    join(bundleDir, 'lifecycle-root.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      verdictId,
      domainId: 'eval:capability-tips',
      createdAt: '2026-07-18T00:00:00.000Z',
      verdict: 'fix',
      harnessUnderEval: { featureId: 'F268', componentId: 'tips', name: 'Capability Tips' },
      ownerAsk: {
        targetFeatureId: 'F268',
        targetOwnerCatId: 'codex-sol',
        requestedAction: 'repair the tips harness',
      },
      acceptanceReevalPlan: {
        nextEvalAt: '2026-07-25T00:00:00.000Z',
        closureCondition: 'the next eval verifies the repair',
      },
    })}\n`,
  );
  writeFileSync(
    join(harnessFeedbackRoot, 'eval-domains', 'eval-capability-tips.yaml'),
    `domainId: eval:capability-tips
displayName: Capability Tips Eval
systemThreadId: thread_eval_capability_tips
evalCat:
  catId: registry-eval
  handle: "@registry-eval"
  model: registry-model
frequency: weekly
sourceAdapter: capability-tips-eval
sourceRefsKind: capability-tips-window
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent: [verdict-discussion]
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F268
  ownerCatId: codex-sol
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
fixtures: []
`,
  );
  return harnessFeedbackRoot;
}

function item(overrides = {}) {
  return {
    id: verdictId,
    domainId: 'eval:capability-tips',
    verdict: 'fix',
    harnessUnderEval: { featureId: 'F268', componentId: 'tips', name: 'Capability Tips' },
    evidence: {
      attributionRefs: [`attribution:bundle/${verdictId}/finding-1`],
      metricRefs: ['metric:tips.missed'],
    },
    lifecycle: {
      availability: 'unavailable',
      ownerResponseStatus: 'unavailable',
      closureStatus: 'unavailable',
      stale: false,
      unavailableReason: 'canonical lifecycle event log unavailable',
    },
    ...overrides,
  };
}

function summary(items, generatedAt = '2026-07-20T00:00:00.000Z') {
  return {
    generatedAt,
    counts: {
      total: items.length,
      actionable: items.filter((entry) => entry.verdict !== 'keep_observe').length,
      keepObserve: items.filter((entry) => entry.verdict === 'keep_observe').length,
      stale: items.filter((entry) => entry.lifecycle.stale).length,
      registeredDomains: 1,
    },
    items,
  };
}

function staleItem() {
  const base = item();
  return { ...base, lifecycle: { ...base.lifecycle, stale: true } };
}

class MemoryEventLog {
  constructor(events) {
    this.events = events;
  }

  async read(id) {
    return id === verdictId ? structuredClone(this.events) : [];
  }
}

function resolvedEvents() {
  const base = {
    verdictId,
    domainId: 'eval:capability-tips',
    occurredAt: '2026-07-18T01:00:00.000Z',
  };
  return [
    {
      ...base,
      eventId: 'opened',
      type: 'verdict_opened',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      reason: 'opened from immutable root',
      refs: [availableRef('verdict', `docs/harness-feedback/verdicts/${verdictId}.md`)],
    },
    {
      ...base,
      eventId: 'ack',
      type: 'owner_acknowledged',
      actor: { kind: 'cat', id: 'codex-sol' },
      reason: 'owner accepted',
      refs: [availableRef('message', 'thread:owner-response')],
    },
    {
      ...base,
      eventId: 'plan',
      type: 'action_planned',
      actor: { kind: 'cat', id: 'codex-sol' },
      reason: 'owner planned repair',
      refs: [availableRef('plan', 'docs/plans/f268.md')],
    },
    {
      ...base,
      eventId: 'fix',
      type: 'fix_recorded',
      actor: { kind: 'cat', id: 'codex-sol' },
      reason: 'repair landed',
      refs: [availableRef('commit', 'deadbeef')],
    },
    {
      ...base,
      eventId: 'reeval-request',
      type: 'reeval_requested',
      actor: { kind: 'cat', id: 'codex-sol' },
      assignedEvalCatId: 'gpt52',
      dueAt: '2026-07-25T00:00:00.000Z',
      reason: 'ready for re-evaluation',
      refs: [{ kind: 'reeval', availability: 'unavailable', unavailableReason: 'run not started yet' }],
    },
    {
      ...base,
      eventId: 'reeval-pass',
      type: 'reeval_passed',
      actor: { kind: 'cat', id: 'gpt52' },
      assignedEvalCatId: 'gpt52',
      reason: 'the repaired behavior passed',
      refs: [availableRef('reeval', 'eval:capability-tips:pass')],
    },
  ];
}

function secondReevalCycleEvents() {
  const events = resolvedEvents().slice(0, -1);
  events.push(
    lifecycleEvent({
      eventId: 'reeval-fail',
      type: 'reeval_failed',
      actor: { kind: 'cat', id: 'gpt52' },
      assignedEvalCatId: 'gpt52',
      occurredAt: '2026-07-18T02:00:00.000Z',
      reason: 'the first repair did not pass re-evaluation',
      refs: [availableRef('reeval', 'eval:capability-tips:first-failure')],
    }),
    lifecycleEvent({
      eventId: 'retry-fix',
      type: 'fix_recorded',
      actor: { kind: 'cat', id: 'codex-sol' },
      occurredAt: '2026-07-18T03:00:00.000Z',
      reason: 'owner landed a second repair',
      refs: [availableRef('commit', 'feedface')],
    }),
    lifecycleEvent({
      eventId: 'retry-request',
      type: 'reeval_requested',
      actor: { kind: 'cat', id: 'codex-sol' },
      assignedEvalCatId: 'registry-eval',
      occurredAt: '2026-07-18T04:00:00.000Z',
      dueAt: '2026-07-26T00:00:00.000Z',
      reason: 'the second repair is ready for re-evaluation',
      refs: [availableRef('reeval', 'eval:capability-tips:second-request')],
    }),
  );
  return events;
}

describe('Eval Hub lifecycle projection', () => {
  it('keeps artifact-only summaries honest when the canonical event reader is unavailable', async (t) => {
    const harnessFeedbackRoot = setupRoot(t);
    const observing = item({
      id: 'observing-verdict',
      verdict: 'keep_observe',
      lifecycle: {
        availability: 'not_required',
        ownerResponseStatus: 'not_required',
        closureStatus: 'observing',
        stale: false,
      },
    });

    const enriched = await enrichEvalHubLifecycle(summary([item(), observing]), { harnessFeedbackRoot });

    assert.equal(enriched.items[0].lifecycle.availability, 'unavailable');
    assert.equal(enriched.items[0].lifecycle.ownerResponseStatus, 'unavailable');
    assert.equal(enriched.items[1].lifecycle.availability, 'not_required');
  });

  it('projects trusted owner, backlinks, unavailable evidence, re-eval, and diagnosis target from replay', async (t) => {
    const harnessFeedbackRoot = setupRoot(t);
    const eventLog = new MemoryEventLog(resolvedEvents());

    const enriched = await enrichEvalHubLifecycle(summary([staleItem()]), {
      harnessFeedbackRoot,
      eventLog,
      assignedEvalCatIds: new Map([['eval:capability-tips', 'gpt52']]),
    });
    const lifecycle = enriched.items[0].lifecycle;

    assert.equal(lifecycle.availability, 'available');
    assert.equal(lifecycle.closureStatus, 'resolved');
    assert.equal(lifecycle.ownerResponseStatus, 'acknowledged');
    assert.equal(lifecycle.targetOwnerCatId, 'codex-sol');
    assert.equal(lifecycle.actionRefs[0].value, 'deadbeef');
    assert.equal(lifecycle.reevalStatus, 'passed');
    assert.equal(lifecycle.closureReason, 'the repaired behavior passed');
    assert.equal(lifecycle.stale, false);
    assert.equal(enriched.counts.stale, 0);
    assert.equal(enriched.counts.actionable, 0);
    assert.equal(lifecycle.unavailableRefs[0].unavailableReason, 'run not started yet');
    assert.deepEqual(lifecycle.diagnosisTarget, {
      featureId: 'F268',
      componentId: 'tips',
      name: 'Capability Tips',
      attributionRefs: [`attribution:bundle/${verdictId}/finding-1`],
      metricRefs: ['metric:tips.missed'],
    });
  });

  it('clears legacy staleness after reasoned operator suppression', async (t) => {
    const harnessFeedbackRoot = setupRoot(t);
    const [opened] = resolvedEvents();
    const suppressed = {
      verdictId,
      domainId: 'eval:capability-tips',
      eventId: 'suppressed',
      type: 'cvo_suppressed',
      actor: { kind: 'cvo', id: 'owner-user' },
      occurredAt: '2026-07-18T02:00:00.000Z',
      reason: 'operator accepts the evidenced tradeoff',
      refs: [availableRef('other', 'decision:f266-suppressed')],
    };

    const enriched = await enrichEvalHubLifecycle(summary([staleItem()]), {
      harnessFeedbackRoot,
      eventLog: new MemoryEventLog([opened, suppressed]),
    });
    const lifecycle = enriched.items[0].lifecycle;

    assert.equal(lifecycle.closureStatus, 'suppressed_with_reason');
    assert.equal(lifecycle.stale, false);
    assert.equal(enriched.counts.stale, 0);
    assert.equal(enriched.counts.actionable, 0);
  });

  it('derives the active cycle attention state from canonical due time after an earlier failure', async (t) => {
    const harnessFeedbackRoot = setupRoot(t);

    const enriched = await enrichEvalHubLifecycle(summary([staleItem()]), {
      harnessFeedbackRoot,
      eventLog: new MemoryEventLog(secondReevalCycleEvents()),
    });
    const lifecycle = enriched.items[0].lifecycle;

    assert.equal(lifecycle.closureStatus, 'reeval_pending');
    assert.equal(lifecycle.reevalStatus, 'pending');
    assert.equal(lifecycle.reevalDueAt, '2026-07-26T00:00:00.000Z');
    assert.equal(lifecycle.stale, false);
    assert.equal(enriched.counts.stale, 0);
    assert.equal(enriched.counts.actionable, 1);
    const overdue = await enrichEvalHubLifecycle(summary([item()], '2026-07-27T00:00:00.000Z'), {
      harnessFeedbackRoot,
      eventLog: new MemoryEventLog(secondReevalCycleEvents()),
    });
    assert.equal(overdue.items[0].lifecycle.stale, true);
    assert.equal(overdue.counts.stale, 1);
  });

  it('surfaces recoverable SLA escalation without fabricating a repair', async (t) => {
    const harnessFeedbackRoot = setupRoot(t);
    const events = resolvedEvents().slice(0, 1);
    events.push({
      verdictId,
      domainId: 'eval:capability-tips',
      eventId: 'sla',
      type: 'sla_escalated',
      actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      occurredAt: '2026-07-21T00:00:00.000Z',
      dueAt: '2026-07-20T00:00:00.000Z',
      stage: 'acknowledgement',
      reason: 'owner acknowledgement overdue',
      refs: [availableRef('sla', 'sla:ack')],
    });

    const enriched = await enrichEvalHubLifecycle(summary([item()]), {
      harnessFeedbackRoot,
      eventLog: new MemoryEventLog(events),
    });
    const lifecycle = enriched.items[0].lifecycle;

    assert.equal(lifecycle.closureStatus, 'escalated');
    assert.equal(lifecycle.escalation.stage, 'acknowledgement');
    assert.deepEqual(lifecycle.actionRefs, []);
    assert.equal(lifecycle.stale, true);
    assert.equal(enriched.counts.stale, 1);
  });
});
