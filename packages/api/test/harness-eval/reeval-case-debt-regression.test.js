import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { projectLifecyclePresentation } from '../../dist/infrastructure/harness-eval/hub/eval-hub-lifecycle-debt.js';
import { enrichEvalHubLifecycle } from '../../dist/infrastructure/harness-eval/hub/eval-hub-lifecycle-projection.js';
import { projectReevalCase } from '../../dist/infrastructure/harness-eval/reeval-case.js';

const caseId = `eval-case-v1-${'e'.repeat(64)}`;
const domainId = 'eval:task-outcome';
const monitorVerdictId = 'monitor-week';
const ref = (kind, value) => ({ kind, availability: 'available', value });

function cycle(verdictId, createdAt, verdict) {
  return { verdictId, createdAt, verdict };
}

function root(cycles) {
  return {
    caseId,
    domainId,
    targetOwnerCatId: 'opus',
    assignedEvalCatId: 'gpt52',
    cycles,
  };
}

function artifact(overrides = {}) {
  return {
    schemaVersion: 2,
    caseId,
    findingKey: 'phase-g-v0-control-plane',
    verdictId: monitorVerdictId,
    domainId,
    createdAt: '2026-08-01T00:00:00.000Z',
    verdict: 'keep_observe',
    harnessUnderEval: { featureId: 'F192', componentId: 'Phase-G-v0', name: 'Phase G' },
    ownerAsk: { targetFeatureId: 'F192', targetOwnerCatId: 'opus', requestedAction: 'continue observing' },
    acceptanceReevalPlan: {
      nextEvalAt: '2026-08-08T00:00:00.000Z',
      closureCondition: 'trusted cadence sample passes',
    },
    ...overrides,
  };
}

function event(type, overrides = {}) {
  const verdictId = overrides.verdictId ?? monitorVerdictId;
  const actors = {
    verdict_cycle_observed: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
    responsibility_bound: { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
    action_planned: { kind: 'cat', id: 'opus' },
    main_landed: { kind: 'cat', id: 'opus' },
    live_active: { kind: 'cat', id: 'opus' },
    reeval_requested: { kind: 'cat', id: 'gpt52' },
    reeval_failed: { kind: 'cat', id: 'gpt52' },
  };
  return {
    eventId: overrides.eventId ?? `${type}:${verdictId}`,
    caseId,
    verdictId,
    domainId,
    type,
    actor: actors[type],
    occurredAt: overrides.occurredAt ?? '2026-08-08T00:01:00.000Z',
    reason: `${type} evidence`,
    refs: overrides.refs ?? [ref('verdict', `verdict:${verdictId}`)],
    ...(type === 'verdict_cycle_observed' ? { cycleCreatedAt: overrides.cycleCreatedAt } : {}),
    ...(type === 'responsibility_bound' ? { taskId: 'task-repair', leaseId: 'lease-repair', leaseGeneration: 1 } : {}),
    ...(['main_landed', 'live_active'].includes(type) ? { commitSha: overrides.commitSha } : {}),
    ...(type === 'reeval_requested' ? { dueAt: '2026-08-10T00:00:00.000Z', assignedEvalCatId: 'gpt52' } : {}),
    ...(type === 'reeval_failed' ? { assignedEvalCatId: 'gpt52' } : {}),
    ...overrides,
  };
}

function monitorFailureEvents() {
  return [
    event('verdict_cycle_observed', { cycleCreatedAt: '2026-08-01T00:00:00.000Z' }),
    event('reeval_requested'),
    event('reeval_failed'),
  ];
}

function setupHarness(t, activeRoot) {
  const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'f266-debt-regression-'));
  t.after(() => rmSync(harnessFeedbackRoot, { recursive: true, force: true }));
  mkdirSync(join(harnessFeedbackRoot, 'eval-domains'), { recursive: true });
  mkdirSync(join(harnessFeedbackRoot, 'bundles', activeRoot.verdictId), { recursive: true });
  writeFileSync(
    join(harnessFeedbackRoot, 'eval-domains', 'eval-task-outcome.yaml'),
    `domainId: eval:task-outcome
displayName: Task Outcome
systemThreadId: thread_eval_task_outcome
evalCat: { catId: gpt52, handle: "@gpt52", model: gpt-5.4 }
frequency: weekly
sourceAdapter: task-outcome
sourceRefsKind: task-outcome-window
threadPolicy: { role: working-home, stateSot: registry, allowedContent: [verdict-discussion] }
legacyScheduledTaskIds: []
handoffTargetResolver: { featureId: F192, ownerCatId: opus, threadLookup: feature-thread }
sla: { acknowledgeHours: 48, reevalWithinHours: 168 }
fixtures: []
`,
  );
  writeFileSync(
    join(harnessFeedbackRoot, 'bundles', activeRoot.verdictId, 'lifecycle-root.json'),
    `${JSON.stringify(activeRoot)}\n`,
  );
  return harnessFeedbackRoot;
}

describe('F266 lifecycle debt invariants', () => {
  it('turns a failed monitoring cadence into an owner-bindable repair debt', () => {
    const activeRoot = artifact();
    const projection = projectReevalCase(
      root([cycle(monitorVerdictId, activeRoot.createdAt, activeRoot.verdict)]),
      monitorFailureEvents(),
    );
    const presentation = projectLifecyclePresentation(projection, '2026-08-09T00:00:00.000Z', activeRoot);

    assert.equal(projection.status, 'open');
    assert.equal(projection.lifecycleOwnerCatId, undefined);
    assert.equal(presentation.repairDebtStatus, 'active');
    assert.equal(presentation.reevalDebtStatus, 'failed');
  });

  it('keeps the reopened keep-observe case in the Hub actionable count', async (t) => {
    const activeRoot = artifact();
    const harnessFeedbackRoot = setupHarness(t, activeRoot);
    const summary = {
      generatedAt: '2026-08-09T00:00:00.000Z',
      counts: { total: 1, actionable: 0, keepObserve: 1, stale: 0, registeredDomains: 1 },
      domains: [
        {
          domainId,
          latestVerdictId: monitorVerdictId,
          latestVerdict: 'keep_observe',
        },
      ],
      items: [
        {
          id: monitorVerdictId,
          packetId: monitorVerdictId,
          domainId,
          verdict: 'keep_observe',
          harnessUnderEval: activeRoot.harnessUnderEval,
          evidence: { attributionRefs: ['attribution:monitor'], metricRefs: ['metric:monitor'] },
          lifecycle: {
            availability: 'unavailable',
            ownerResponseStatus: 'unavailable',
            closureStatus: 'unavailable',
            stale: false,
          },
        },
      ],
    };

    const enriched = await enrichEvalHubLifecycle(summary, {
      harnessFeedbackRoot,
      eventLog: { read: async () => monitorFailureEvents() },
    });

    assert.equal(enriched.items[0].lifecycle.closureStatus, 'open');
    assert.equal(enriched.items[0].lifecycle.repairDebtStatus, 'active');
    assert.equal(enriched.counts.actionable, 1);
  });

  it('projects a new repair activation cadence instead of a sticky prior failure', () => {
    const activeRoot = artifact({ verdict: 'fix' });
    const commitA = 'a'.repeat(40);
    const commitB = 'b'.repeat(40);
    const events = [
      event('verdict_cycle_observed', { cycleCreatedAt: activeRoot.createdAt }),
      event('responsibility_bound'),
      event('action_planned'),
      event('main_landed', { commitSha: commitA }),
      event('live_active', { commitSha: commitA }),
      event('reeval_requested'),
      event('reeval_failed'),
      event('action_planned', { eventId: 'action_planned:retry' }),
      event('main_landed', { eventId: 'main_landed:retry', commitSha: commitB }),
      event('live_active', { eventId: 'live_active:retry', commitSha: commitB }),
    ];
    const projection = projectReevalCase(root([cycle(monitorVerdictId, activeRoot.createdAt, 'fix')]), events);
    const presentation = projectLifecyclePresentation(projection, '2026-08-09T00:00:00.000Z', activeRoot);

    assert.equal(projection.status, 'live_active');
    assert.equal(presentation.repairDebtStatus, 'cleared');
    assert.equal(presentation.reevalDebtStatus, 'due');
  });

  it('never lets a backdated cycle displace the active monitoring cycle', () => {
    const oldVerdictId = 'older-fix';
    const cycles = [
      cycle(oldVerdictId, '2026-07-25T00:00:00.000Z', 'fix'),
      cycle(monitorVerdictId, '2026-08-01T00:00:00.000Z', 'keep_observe'),
    ];
    const projection = projectReevalCase(root(cycles), [
      event('verdict_cycle_observed', { cycleCreatedAt: '2026-08-01T00:00:00.000Z' }),
      event('verdict_cycle_observed', {
        eventId: 'observe:older-fix',
        verdictId: oldVerdictId,
        cycleCreatedAt: '2026-07-25T00:00:00.000Z',
        occurredAt: '2026-08-02T00:00:00.000Z',
      }),
    ]);

    assert.equal(projection.status, 'monitoring');
    assert.equal(projection.activeVerdictId, monitorVerdictId);
  });
});
