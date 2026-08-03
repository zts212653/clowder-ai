import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);
const { buildFreshnessReplayReport, readFreshnessClosureEvalSnapshot } = await import(
  '../dist/infrastructure/harness-eval/freshness/freshness-closure-eval-adapter.js'
);

describe('F254 Phase E — replayable closure eval adapter', () => {
  it('reports unresolved responsibility instead of treating detection as success', async () => {
    const store = new InMemoryFreshnessClosureStore();
    await store.openOrAdvance({
      closureId: 'closure-1',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      invocationId: 'base-1',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'stale',
      requiredMessageIds: ['msg-2'],
      requiredFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 100,
    });

    const snapshot = await readFreshnessClosureEvalSnapshot({
      store,
      fromInclusive: 0,
      toExclusive: 200,
    });
    assert.equal(snapshot.closureCount, 1);
    assert.equal(snapshot.unresolvedCount, 1);
    assert.equal(snapshot.committedCount, 0);
    assert.equal(snapshot.verdict, 'needs_attention');
  });

  it('reports a single custody-proven committed final as healthy', async () => {
    const store = new InMemoryFreshnessClosureStore();
    await store.openOrAdvance({
      closureId: 'closure-committed',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      invocationId: 'base-1',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'stale',
      requiredMessageIds: ['msg-2'],
      requiredFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 100,
    });
    await store.claimAttempt('closure-committed', {
      invocationId: 'successor-1',
      inputFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 110,
    });
    await store.commit('closure-committed', {
      invocationId: 'successor-1',
      messageId: 'final-1',
      observedRawFrontierMessageId: 'msg-2',
      evidenceRefs: ['atomic-append:final-1'],
      now: 120,
    });

    const snapshot = await readFreshnessClosureEvalSnapshot({ store, fromInclusive: 0, toExclusive: 200 });
    assert.equal(snapshot.committedCount, 1);
    assert.equal(snapshot.custodyGapCount, 0);
    assert.equal(snapshot.redundantCommittedAttemptCount, 0);
    assert.equal(snapshot.lineageIdentityGapCount, 0);
    assert.equal(snapshot.verdict, 'healthy');
  });

  it('counts startup recovery blocks separately from model-attempt failures', async () => {
    const store = new InMemoryFreshnessClosureStore();
    await store.openOrAdvance({
      closureId: 'closure-startup-blocked',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'gpt52',
      invocationId: 'base-1',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'stale',
      requiredMessageIds: ['msg-2'],
      requiredFrontierMessageId: 'msg-2',
      observedRawFrontierMessageId: 'msg-2',
      now: 100,
    });
    await store.blockRecovery('closure-startup-blocked', {
      evidenceRefs: ['startup:pending_requires_explicit_retry'],
      now: 110,
    });

    const snapshot = await readFreshnessClosureEvalSnapshot({ store, fromInclusive: 0, toExclusive: 200 });
    assert.equal(snapshot.startupRecoveryBlockedCount, 1);
    assert.equal(snapshot.blockedCount, 1);
    assert.equal(snapshot.verdict, 'needs_attention');
  });

  it('has an executable red case for every freshness violation predicate', () => {
    const baseline = {
      responsibilityCount: 1,
      custodyCount: 1,
      formalFinalCount: 1,
      formalFinalLimit: 1,
      knownStaleFinalCount: 0,
      targetCount: 1,
      accountedTargetCount: 1,
      sameBatchSiblingWakeCount: 0,
      automaticAttemptCount: 1,
      automaticAttemptLimit: 5,
      commitRecheckCount: 1,
      commitRecheckLimit: 10,
      terminalEvidenceComplete: true,
    };
    const cases = [
      ['responsibility_without_custody', { custodyCount: 0 }],
      ['formal_final_limit_exceeded', { formalFinalCount: 2 }],
      ['known_stale_final_visible', { knownStaleFinalCount: 1 }],
      ['target_outcome_missing', { accountedTargetCount: 0 }],
      ['same_batch_sibling_triggered', { sameBatchSiblingWakeCount: 1 }],
      ['automatic_attempt_budget_exceeded', { automaticAttemptCount: 6 }],
      ['commit_recheck_budget_exceeded', { commitRecheckCount: 11 }],
      ['terminal_evidence_missing', { terminalEvidenceComplete: false }],
    ];

    for (const [expected, mutation] of cases) {
      const sample = {
        id: `mutation:${expected}`,
        scenario: 'original_double_message_dogfood',
        source: 'live_closure',
        occurredAt: 100,
        threadId: 'thread-1',
        catIds: ['codex-sol'],
        traceRef: `trace:${expected}`,
        evidenceRefs: [`evidence:${expected}`],
        facts: { ...baseline, ...mutation },
        attentionReasons: [],
      };
      const report = buildFreshnessReplayReport(
        { kind: 'freshness-closure-replay', windowStartMs: 0, windowEndMs: 200 },
        [sample],
      );
      assert.deepEqual(report.evaluations[0].violations, [expected], expected);
    }
  });
});
