import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);
const { FRESHNESS_AC_E9_SCENARIOS } = await import(
  '../dist/infrastructure/harness-eval/freshness/freshness-replay-fixtures.js'
);
const { FreshnessReplayProviderImpl } = await import(
  '../dist/infrastructure/harness-eval/freshness/freshness-replay-provider.js'
);

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixtureRoot = `${repoRoot}/docs/harness-feedback/fixtures/f254`;

function selector(overrides = {}) {
  return {
    kind: 'freshness-closure-replay',
    windowStartMs: 1_000,
    windowEndMs: 2_000,
    ...overrides,
  };
}

describe('F254 AC-E9 freshness replay provider', () => {
  it('always resolves all eight server-owned structural fixtures without caller selection', async () => {
    const provider = new FreshnessReplayProviderImpl({
      store: new InMemoryFreshnessClosureStore(),
      fixtureRoot,
    });

    const replay = await provider.resolve(selector());

    assert.equal(replay.samples.length, 8);
    assert.deepEqual(
      [...new Set(replay.samples.map((sample) => sample.scenario))].sort(),
      [...FRESHNESS_AC_E9_SCENARIOS].sort(),
    );
    assert.ok(replay.samples.every((sample) => sample.source === 'fixture'));
    assert.ok(replay.samples.every((sample) => sample.traceRef.startsWith('trace:f254-ac-e9/')));
    assert.ok(replay.samples.every((sample) => sample.evidenceRefs.length > 0));
    assert.equal(replay.report.eligibleSampleCount, 8);
    assert.equal(replay.report.failedSampleCount, 0);
    assert.equal(replay.report.verdict, 'no_data');
    assert.equal(replay.report.healthy, false);
  });

  it('reports fixture-only conformance as explicit live no-data, never healthy', async () => {
    const provider = new FreshnessReplayProviderImpl({
      store: new InMemoryFreshnessClosureStore(),
      fixtureRoot,
    });

    const replay = await provider.resolve(selector());

    assert.equal(replay.samples.length, 8);
    assert.equal(replay.report.fixtureSampleCount, 8);
    assert.equal(replay.report.liveSampleCount, 0);
    assert.equal(replay.report.verdict, 'no_data');
    assert.equal(replay.report.healthy, false);
    assert.match(replay.report.noDataReason, /no eligible live/i);
  });

  it('filters live closure evidence by thread and surfaces blocked custody as attention', async () => {
    const store = new InMemoryFreshnessClosureStore();
    await store.openOrAdvance({
      closureId: 'closure-live-blocked',
      userId: 'user-1',
      threadId: 'thread-live',
      catId: 'codex-sol',
      invocationId: 'inv-original',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'withheld draft',
      requiredMessageIds: ['msg-new'],
      requiredFrontierMessageId: 'msg-new',
      observedRawFrontierMessageId: 'msg-new',
      now: 1_200,
    });
    await store.blockRecovery('closure-live-blocked', {
      evidenceRefs: ['startup:explicit-retry-required'],
      now: 1_300,
    });
    const provider = new FreshnessReplayProviderImpl({ store, fixtureRoot });

    const excluded = await provider.resolve(selector({ threadIds: ['thread-other'] }));
    assert.equal(excluded.report.verdict, 'no_data');

    const included = await provider.resolve(selector({ threadIds: ['thread-live'] }));
    assert.equal(included.samples.length, 9);
    const live = included.samples.find((sample) => sample.source === 'live_closure');
    assert.equal(live.traceRef, 'trace:freshness-closure/closure-live-blocked@r1');
    assert.equal(included.report.verdict, 'needs_attention');
    assert.equal(included.report.attentionSampleCount, 1);
  });

  it('projects replay-unsafe connector blocks as terminal proof without pretending the responsibility is resolved', async () => {
    const store = new InMemoryFreshnessClosureStore();
    await store.openOrAdvance({
      closureId: 'closure-live-replay-unsafe',
      userId: 'user-1',
      threadId: 'thread-live',
      catId: 'codex-sol',
      invocationId: 'inv-original',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'withheld draft after side effect',
      requiredMessageIds: ['msg-new'],
      requiredFrontierMessageId: 'msg-new',
      observedRawFrontierMessageId: 'msg-new',
      replayUnsafeToolNames: ['mcp__cat-cafe-collab__cat_cafe_hold_ball'],
      now: 1_200,
    });
    const provider = new FreshnessReplayProviderImpl({ store, fixtureRoot });

    const replay = await provider.resolve(selector({ threadIds: ['thread-live'] }));
    const live = replay.samples.find((sample) => sample.source === 'live_closure');
    const evaluation = replay.report.evaluations.find((item) => item.sampleId === live.id);

    assert.equal(live.scenario, 'connector_blocked');
    assert.equal(live.facts.terminalEvidenceComplete, true);
    assert.ok(live.attentionReasons.includes('blocked_responsibility'));
    assert.ok(!evaluation.violations.includes('terminal_evidence_missing'));
    assert.equal(replay.report.verdict, 'needs_attention');
  });

  it('applies the same thread selector to provider-native coverage events', async () => {
    const event = (threadId) => ({
      kind: 'provider_notice_opportunity',
      threadId,
      catId: 'codex-sol',
      invocationId: `inv-${threadId}`,
      timestamp: 1_200,
      noticeId: `notice-${threadId}`,
      frontier: `message-${threadId}`,
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
      toolSurface: 'command_execution',
      expectedTurnId: `turn-${threadId}`,
    });
    const provider = new FreshnessReplayProviderImpl({
      store: new InMemoryFreshnessClosureStore(),
      fixtureRoot,
      providerNativeEventLog: {
        async queryProviderNativeBetween() {
          return [event('thread-included'), event('thread-excluded')];
        },
      },
    });

    const replay = await provider.resolve(selector({ threadIds: ['thread-included'] }));
    assert.equal(replay.providerNativeCoverage.cells.length, 1);
    assert.equal(replay.providerNativeCoverage.cells[0].opportunityCount, 1);
  });

  it('derives duplicate-final and stale-custody violations from durable live attempts', async () => {
    const committedAttempt = (invocationId, inputFrontierMessageId) => ({
      invocationId,
      inputFrontierMessageId,
      observedRawFrontierMessageId: inputFrontierMessageId,
      draftHash: 'a'.repeat(64),
      draftLength: 4,
      outcome: 'committed',
      evidenceRefs: [`append:${invocationId}`],
      createdAt: 1_200,
    });
    const liveClosure = {
      id: 'closure-live-duplicate',
      userId: 'user-1',
      threadId: 'thread-live',
      catId: 'codex-sol',
      originTriggerMessageId: 'msg-origin',
      turnInvocationId: 'turn-1',
      status: 'committed',
      requiredFrontierMessageId: 'msg-current',
      requiredMessageIds: ['msg-current'],
      observedRawFrontierMessageId: 'msg-current',
      baseDraft: { content: 'base', hash: 'b'.repeat(64), length: 4, invocationId: 'base-1' },
      latestDraft: { content: 'done', hash: 'c'.repeat(64), length: 4, invocationId: 'inv-2' },
      attempts: [committedAttempt('inv-1', 'msg-stale'), committedAttempt('inv-2', 'msg-current')],
      automaticSuccessorAttemptCount: 2,
      retryEpoch: 0,
      committedInvocationId: 'inv-2',
      committedMessageId: 'message-final',
      revision: 3,
      createdAt: 1_100,
      updatedAt: 1_300,
    };
    const provider = new FreshnessReplayProviderImpl({
      store: {
        async listUpdatedBetween() {
          return [liveClosure];
        },
      },
      fixtureRoot,
    });

    const replay = await provider.resolve(selector());
    const evaluation = replay.report.evaluations.find((item) => item.sampleId.startsWith('closure:'));

    assert.ok(evaluation.violations.includes('formal_final_limit_exceeded'));
    assert.ok(evaluation.violations.includes('known_stale_final_visible'));
    assert.equal(replay.aggregateSnapshot.redundantCommittedAttemptCount, 1);
    assert.equal(replay.aggregateSnapshot.custodyGapCount, 1);
  });
});
