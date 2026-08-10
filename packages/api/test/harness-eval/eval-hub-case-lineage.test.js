import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { enrichEvalHubLifecycle } from '../../dist/infrastructure/harness-eval/hub/eval-hub-lifecycle-projection.js';

const caseId = `eval-case-v1-${'a'.repeat(64)}`;
const verdictIds = ['capability-wakeup-2026-08-01-rich-messaging', 'capability-wakeup-2026-08-08-rich-messaging'];
const ref = (kind, value) => ({ kind, availability: 'available', value });

function setupRoot(t, secondVerdict = 'fix') {
  const root = mkdtempSync(join(tmpdir(), 'f266-hub-case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'eval-domains'), { recursive: true });
  writeFileSync(
    join(root, 'eval-domains', 'eval-capability-wakeup.yaml'),
    `domainId: eval:capability-wakeup
displayName: Capability Wakeup
systemThreadId: thread_eval_capability_wakeup
evalCat: { catId: gpt52, handle: "@gpt52", model: gpt-5.4 }
frequency: weekly
sourceAdapter: capability-wakeup
sourceRefsKind: capability-wakeup-window
threadPolicy: { role: working-home, stateSot: registry, allowedContent: [verdict-discussion] }
legacyScheduledTaskIds: []
handoffTargetResolver: { featureId: F266, ownerCatId: codex-sol, threadLookup: feature-thread }
sla: { acknowledgeHours: 48, reevalWithinHours: 168 }
fixtures: []
`,
  );
  for (const [index, verdictId] of verdictIds.entries()) {
    const bundle = join(root, 'bundles', verdictId);
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      join(bundle, 'lifecycle-root.json'),
      `${JSON.stringify({
        schemaVersion: 2,
        caseId,
        findingKey: 'rich-messaging',
        verdictId,
        domainId: 'eval:capability-wakeup',
        createdAt: `2026-08-${String(1 + index * 7).padStart(2, '0')}T00:00:00.000Z`,
        verdict: index === 1 ? secondVerdict : 'fix',
        harnessUnderEval: { featureId: 'F266', componentId: 'rich-messaging', name: 'Rich messaging' },
        ownerAsk: {
          targetFeatureId: 'F266',
          targetOwnerCatId: 'codex-sol',
          requestedAction: 'repair rich messaging wakeup',
        },
        acceptanceReevalPlan: {
          nextEvalAt: '2026-08-15T00:00:00.000Z',
          closureCondition: 'new real sample passes',
        },
      })}\n`,
    );
  }
  return root;
}

function item(id, verdict = 'fix') {
  return {
    id,
    packetId: id,
    domainId: 'eval:capability-wakeup',
    verdict,
    harnessUnderEval: { featureId: 'F266', componentId: 'rich-messaging', name: 'Rich messaging' },
    evidence: {
      attributionRefs: [`attribution:${id}`],
      metricRefs: ['metric:wakeup'],
      snapshotRefs: [],
      otherRefs: [],
    },
    lifecycle: {
      availability: 'unavailable',
      ownerResponseStatus: 'unavailable',
      closureStatus: 'unavailable',
      stale: true,
    },
    source: { verdictPath: `verdicts/${id}.md`, bundleDir: `bundles/${id}` },
  };
}

function event(type, verdictId, extra = {}) {
  return {
    eventId: `${type}:${verdictId}`,
    caseId,
    verdictId,
    domainId: 'eval:capability-wakeup',
    type,
    actor: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
    occurredAt: '2026-08-08T00:01:00.000Z',
    reason: `${type} evidence`,
    refs: [ref('verdict', `verdict:${verdictId}`)],
    ...extra,
  };
}

describe('F266 Eval Hub stable case lineage', () => {
  it('keeps unresolved feature-thread responsibility visible as an actionable tracked blocker', async (t) => {
    const harnessFeedbackRoot = setupRoot(t);
    const events = [
      event('verdict_cycle_observed', verdictIds[0], { cycleCreatedAt: '2026-08-01T00:00:00.000Z' }),
      event('responsibility_blocked', verdictIds[0], {
        reasonCode: 'feature_thread_not_found',
        featureId: 'F266',
        ownerCatId: 'codex-sol',
        candidateThreadIds: [],
        refs: [ref('other', 'feature-thread-resolution:F266:feature_thread_not_found')],
      }),
    ];
    const summary = {
      generatedAt: '2026-08-09T00:00:00.000Z',
      counts: { total: 2, actionable: 2, keepObserve: 0, stale: 2, registeredDomains: 1 },
      domains: [],
      items: verdictIds.map(item),
    };

    const enriched = await enrichEvalHubLifecycle(summary, {
      harnessFeedbackRoot,
      eventLog: { read: async (subjectId) => (subjectId === caseId ? structuredClone(events) : []) },
    });

    assert.equal(enriched.items.length, 1);
    assert.equal(enriched.items[0].lifecycle.closureStatus, 'open');
    assert.deepEqual(enriched.items[0].lifecycle.responsibilityBlocker, {
      eventId: `responsibility_blocked:${verdictIds[0]}`,
      reasonCode: 'feature_thread_not_found',
      featureId: 'F266',
      ownerCatId: 'codex-sol',
      candidateThreadIds: [],
    });
    assert.equal(enriched.items[0].lifecycle.taskId, undefined);
    assert.equal(enriched.items[0].lifecycle.leaseId, undefined);
    assert.equal(enriched.counts.actionable, 1);
  });

  it('renders one responsibility card for repeated verdict cycles in the same active case', async (t) => {
    const harnessFeedbackRoot = setupRoot(t);
    const events = [
      event('verdict_cycle_observed', verdictIds[0], { cycleCreatedAt: '2026-08-01T00:00:00.000Z' }),
      event('responsibility_bound', verdictIds[0], {
        taskId: 'task-case-cycle',
        leaseId: 'lease-case-cycle',
        leaseGeneration: 2,
        refs: [ref('task', 'task:case-cycle'), ref('other', 'lease:case-cycle:2')],
      }),
      event('verdict_cycle_observed', verdictIds[1], { cycleCreatedAt: '2026-08-08T00:00:00.000Z' }),
    ];
    const summary = {
      generatedAt: '2026-08-09T00:00:00.000Z',
      counts: { total: 2, actionable: 2, keepObserve: 0, stale: 2, registeredDomains: 1 },
      domains: [],
      items: verdictIds.map(item),
    };

    const enriched = await enrichEvalHubLifecycle(summary, {
      harnessFeedbackRoot,
      eventLog: { read: async (subjectId) => (subjectId === caseId ? structuredClone(events) : []) },
    });

    assert.equal(enriched.items.length, 1);
    assert.equal(enriched.items[0].id, verdictIds[1]);
    assert.equal(enriched.items[0].lifecycle.caseId, caseId);
    assert.equal(enriched.items[0].lifecycle.activeVerdictId, verdictIds[0]);
    assert.deepEqual(enriched.items[0].lifecycle.observedVerdictIds, verdictIds);
    assert.equal(enriched.items[0].lifecycle.taskId, 'task-case-cycle');
    assert.equal(enriched.items[0].lifecycle.leaseId, 'lease-case-cycle');
    assert.equal(enriched.items[0].lifecycle.closureStatus, 'acknowledged');
    assert.equal(enriched.items[0].lifecycle.repairDebtStatus, 'active');
    assert.equal(enriched.items[0].lifecycle.reevalDebtStatus, 'not_scheduled');
    assert.deepEqual(enriched.counts, { total: 1, actionable: 1, keepObserve: 0, stale: 0, registeredDomains: 1 });
  });

  it('does not let a later keep-observe artifact hide an active case before trusted re-evaluation signoff', async (t) => {
    const harnessFeedbackRoot = setupRoot(t, 'keep_observe');
    const events = [
      event('verdict_cycle_observed', verdictIds[0], { cycleCreatedAt: '2026-08-01T00:00:00.000Z' }),
      event('responsibility_bound', verdictIds[0], {
        taskId: 'task-case-cycle',
        leaseId: 'lease-case-cycle',
        leaseGeneration: 1,
        refs: [ref('task', 'task:case-cycle'), ref('other', 'lease:case-cycle:1')],
      }),
      event('action_planned', verdictIds[0], { actor: { kind: 'cat', id: 'codex-sol' } }),
      event('main_landed', verdictIds[0], {
        actor: { kind: 'cat', id: 'codex-sol' },
        commitSha: 'b'.repeat(40),
        refs: [ref('commit', 'main evidence')],
      }),
      event('live_active', verdictIds[0], {
        actor: { kind: 'cat', id: 'codex-sol' },
        commitSha: 'b'.repeat(40),
        refs: [ref('commit', 'live evidence')],
      }),
      event('reeval_requested', verdictIds[0], {
        actor: { kind: 'cat', id: 'codex-sol' },
        dueAt: '2026-08-15T00:00:00.000Z',
        assignedEvalCatId: 'gpt52',
        refs: [ref('reeval', 'next scheduled eval')],
      }),
      event('verdict_cycle_observed', verdictIds[1], { cycleCreatedAt: '2026-08-08T00:00:00.000Z' }),
    ];
    const summary = {
      generatedAt: '2026-08-09T00:00:00.000Z',
      counts: { total: 2, actionable: 1, keepObserve: 1, stale: 0, registeredDomains: 1 },
      domains: [
        {
          domainId: 'eval:capability-wakeup',
          latestVerdictId: verdictIds[1],
          latestVerdict: 'keep_observe',
        },
      ],
      items: [item(verdictIds[1], 'keep_observe'), item(verdictIds[0])],
    };

    const enriched = await enrichEvalHubLifecycle(summary, {
      harnessFeedbackRoot,
      eventLog: { read: async (subjectId) => (subjectId === caseId ? structuredClone(events) : []) },
    });

    assert.equal(enriched.items.length, 1);
    assert.equal(enriched.items[0].id, verdictIds[0]);
    assert.equal(enriched.items[0].verdict, 'fix');
    assert.equal(enriched.items[0].lifecycle.closureStatus, 'reeval_pending');
    assert.equal(enriched.items[0].lifecycle.repairDebtStatus, 'cleared');
    assert.equal(enriched.items[0].lifecycle.reevalDebtStatus, 'in_progress');
    assert.equal(enriched.domains[0].latestVerdictId, verdictIds[0]);
    assert.equal(enriched.domains[0].latestVerdict, 'fix');
    assert.equal(enriched.counts.actionable, 1);
    assert.equal(enriched.counts.keepObserve, 0);
  });

  it('keeps an absorbed actionable cycle visible after the prior cycle resolves', async (t) => {
    const harnessFeedbackRoot = setupRoot(t);
    const events = [
      event('verdict_cycle_observed', verdictIds[0], { cycleCreatedAt: '2026-08-01T00:00:00.000Z' }),
      event('responsibility_bound', verdictIds[0], {
        taskId: 'task-cycle-a',
        leaseId: 'lease-cycle-a',
        leaseGeneration: 1,
        refs: [ref('task', 'task:cycle-a'), ref('other', 'lease:cycle-a:1')],
      }),
      event('action_planned', verdictIds[0], {
        actor: { kind: 'cat', id: 'codex-sol' },
        refs: [ref('plan', 'task:cycle-a')],
      }),
      event('main_landed', verdictIds[0], {
        actor: { kind: 'cat', id: 'codex-sol' },
        commitSha: 'b'.repeat(40),
        refs: [ref('commit', 'main:cycle-a')],
      }),
      event('live_active', verdictIds[0], {
        actor: { kind: 'cat', id: 'codex-sol' },
        commitSha: 'b'.repeat(40),
        refs: [ref('commit', 'live:cycle-a')],
      }),
      event('reeval_requested', verdictIds[0], {
        actor: { kind: 'cat', id: 'codex-sol' },
        dueAt: '2026-08-15T00:00:00.000Z',
        assignedEvalCatId: 'gpt52',
        refs: [ref('reeval', 'reeval:cycle-a')],
      }),
      event('verdict_cycle_observed', verdictIds[1], { cycleCreatedAt: '2026-08-08T00:00:00.000Z' }),
      event('reeval_passed', verdictIds[0], {
        actor: { kind: 'cat', id: 'gpt52' },
        occurredAt: '2026-08-09T00:00:00.000Z',
        assignedEvalCatId: 'gpt52',
        refs: [ref('reeval', 'passed:cycle-a')],
      }),
    ];
    const summary = {
      generatedAt: '2026-08-09T01:00:00.000Z',
      counts: { total: 2, actionable: 2, keepObserve: 0, stale: 0, registeredDomains: 1 },
      domains: [],
      items: verdictIds.map(item),
    };

    const enriched = await enrichEvalHubLifecycle(summary, {
      harnessFeedbackRoot,
      eventLog: { read: async (subjectId) => (subjectId === caseId ? structuredClone(events) : []) },
    });

    assert.equal(enriched.items.length, 1);
    assert.equal(enriched.items[0].id, verdictIds[1]);
    assert.equal(enriched.items[0].lifecycle.activeVerdictId, verdictIds[1]);
    assert.equal(enriched.items[0].lifecycle.closureStatus, 'open');
    assert.equal(enriched.items[0].lifecycle.ownerResponseStatus, 'not_started');
    assert.equal(enriched.items[0].lifecycle.reevalStatus, 'not_requested');
    assert.equal(enriched.items[0].lifecycle.taskId, undefined);
    assert.deepEqual(enriched.items[0].lifecycle.ownerResponseRefs, []);
    assert.deepEqual(enriched.items[0].lifecycle.planRefs, []);
    assert.deepEqual(enriched.items[0].lifecycle.actionRefs, []);
    assert.deepEqual(enriched.items[0].lifecycle.reevalRefs, []);
    assert.equal(enriched.counts.actionable, 1);
  });
});
