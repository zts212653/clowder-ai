import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { enrichEvalHubLifecycle } from '../../dist/infrastructure/harness-eval/hub/eval-hub-lifecycle-projection.js';

const verdictId = 'f266-recovery-projection';
const domainId = 'eval:capability-tips';

function ref(kind, value) {
  return { kind, availability: 'available', value };
}

function event(eventId, type, actor, extras = {}) {
  return {
    verdictId,
    domainId,
    eventId,
    type,
    actor,
    occurredAt: '2026-07-18T01:00:00.000Z',
    reason: `${type} evidence`,
    refs: [ref('other', `evidence:${eventId}`)],
    ...extras,
  };
}

function opened() {
  return event('opened', 'verdict_opened', { kind: 'automation', id: 'publisher' });
}

function eventsThroughRequest() {
  return [
    opened(),
    event('ack', 'owner_acknowledged', { kind: 'cat', id: 'codex-sol' }),
    event('plan', 'action_planned', { kind: 'cat', id: 'codex-sol' }),
    event('fix', 'fix_recorded', { kind: 'cat', id: 'codex-sol' }, { refs: [ref('commit', 'deadbeef')] }),
    event(
      'request',
      'reeval_requested',
      { kind: 'cat', id: 'codex-sol' },
      {
        assignedEvalCatId: 'gpt52',
        dueAt: '2026-07-25T00:00:00.000Z',
        refs: [ref('reeval', 'reeval:request')],
      },
    ),
  ];
}

function setupRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'f266-recovery-projection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundles', verdictId);
  mkdirSync(bundle, { recursive: true });
  mkdirSync(join(root, 'eval-domains'), { recursive: true });
  writeFileSync(
    join(bundle, 'lifecycle-root.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      verdictId,
      domainId,
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
    join(root, 'eval-domains', 'eval-capability-tips.yaml'),
    `domainId: ${domainId}\ndisplayName: Capability Tips Eval\nsystemThreadId: thread_eval_capability_tips\nevalCat:\n  catId: gpt52\n  handle: "@gpt52"\n  model: gpt-5.4\nfrequency: weekly\nsourceAdapter: capability-tips-eval\nsourceRefsKind: capability-tips-window\nthreadPolicy:\n  role: working-home\n  stateSot: registry\n  allowedContent: [verdict-discussion]\nlegacyScheduledTaskIds: []\nhandoffTargetResolver:\n  featureId: F268\n  ownerCatId: codex-sol\n  threadLookup: feature-thread\nsla:\n  acknowledgeHours: 48\n  reevalWithinHours: 168\nfixtures: []\n`,
  );
  return root;
}

async function project(t, events) {
  const harnessFeedbackRoot = setupRoot(t);
  const item = {
    id: verdictId,
    domainId,
    verdict: 'fix',
    evidence: { attributionRefs: [], metricRefs: [] },
    lifecycle: {
      availability: 'unavailable',
      ownerResponseStatus: 'unavailable',
      closureStatus: 'unavailable',
      stale: true,
    },
  };
  const summary = {
    generatedAt: '2026-07-22T00:00:00.000Z',
    counts: { total: 1, actionable: 1, keepObserve: 0, stale: 1, registeredDomains: 1 },
    items: [item],
  };
  const enriched = await enrichEvalHubLifecycle(summary, {
    harnessFeedbackRoot,
    eventLog: { read: async () => structuredClone(events) },
  });
  return enriched.items[0].lifecycle;
}

describe('Eval Hub lifecycle recovery presentation', () => {
  it('removes active re-eval work when operator suppression settles a pending cycle', async (t) => {
    const lifecycle = await project(t, [
      ...eventsThroughRequest(),
      event('suppress', 'cvo_suppressed', { kind: 'cvo', id: 'owner-user' }),
    ]);

    assert.equal(lifecycle.closureStatus, 'suppressed_with_reason');
    assert.equal(lifecycle.reevalStatus, 'not_required');
    assert.equal(lifecycle.reevalDueAt, undefined);
    assert.equal(lifecycle.escalation, undefined);
    assert.equal(lifecycle.ownerResponseStatus, 'not_required');
    assert.equal(lifecycle.stale, false);
  });

  it('exposes escalation only while escalation is the current recoverable state', async (t) => {
    const acknowledgement = event(
      'sla-ack',
      'sla_escalated',
      { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      { stage: 'acknowledgement', dueAt: '2026-07-20T00:00:00.000Z', refs: [ref('sla', 'sla:ack')] },
    );
    const recovered = await project(t, [
      opened(),
      acknowledgement,
      event('late-ack', 'owner_acknowledged', { kind: 'cat', id: 'codex-sol' }),
    ]);
    assert.equal(recovered.closureStatus, 'acknowledged');
    assert.equal(recovered.escalation, undefined);
    assert.equal(recovered.stale, false);

    const reevalEscalation = event(
      'sla-reeval',
      'sla_escalated',
      { kind: 'automation', id: 'eval-verdict-closure-reconciler' },
      { stage: 'reevaluation', dueAt: '2026-07-25T00:00:00.000Z', refs: [ref('sla', 'sla:reeval')] },
    );
    const resolved = await project(t, [
      ...eventsThroughRequest(),
      reevalEscalation,
      event(
        'pass',
        'reeval_passed',
        { kind: 'cat', id: 'gpt52' },
        { assignedEvalCatId: 'gpt52', refs: [ref('reeval', 'reeval:pass')] },
      ),
    ]);
    assert.equal(resolved.closureStatus, 'resolved');
    assert.equal(resolved.reevalStatus, 'passed');
    assert.equal(resolved.reevalDueAt, undefined);
    assert.equal(resolved.escalation, undefined);
    assert.equal(resolved.stale, false);
  });

  it('keeps the failed result but clears the inactive cycle deadline while repair resumes', async (t) => {
    const lifecycle = await project(t, [
      ...eventsThroughRequest(),
      event(
        'failed',
        'reeval_failed',
        { kind: 'cat', id: 'gpt52' },
        { assignedEvalCatId: 'gpt52', refs: [ref('reeval', 'reeval:failed')] },
      ),
    ]);

    assert.equal(lifecycle.closureStatus, 'action_planned');
    assert.equal(lifecycle.reevalStatus, 'failed');
    assert.equal(lifecycle.reevalDueAt, undefined);
    assert.equal(lifecycle.escalation, undefined);
    assert.equal(lifecycle.stale, false);
  });
});
