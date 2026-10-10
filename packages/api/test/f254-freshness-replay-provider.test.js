import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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
      fixtureRoot,
    });

    const replay = await provider.resolve(selector());

    assert.equal(replay.samples.length, 8);
    assert.equal(replay.report.fixtureSampleCount, 8);
    assert.equal(replay.report.liveSampleCount, 0);
    assert.equal(replay.report.verdict, 'no_data');
    assert.equal(replay.report.healthy, false);
    assert.match(replay.report.noDataReason, /no live samples resolved/i);
  });

  it('applies the same thread selector to provider-native coverage events', async () => {
    let requestedThreadIds;
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
      fixtureRoot,
      queueLifecycleSource: {
        async listOwnerDurableEntries() {
          return [];
        },
      },
      messageLifecycleSource: {
        async listOwnerMessagesInWindow() {
          return [];
        },
      },
      attentionEventLog: {
        async queryWindowBetween(_startMs, _endMs, _ownerUserId, options) {
          requestedThreadIds = options.threadIds;
          return {
            events: [event('thread-included'), event('thread-excluded')],
            coverage: { status: 'complete', completeFromMs: 1_000, observedThroughMs: 2_000 },
          };
        },
      },
    });

    const replay = await provider.resolve(selector({ threadIds: ['thread-included'] }), { ownerUserId: 'user-1' });
    assert.equal(replay.providerNativeCoverage.cells.length, 1);
    assert.equal(replay.providerNativeCoverage.cells[0].opportunityCount, 1);
    assert.deepEqual(requestedThreadIds, ['thread-included']);
  });

  it('publishes a mature owner-scoped signal plane even when legacy closures are empty', async () => {
    const queueEntry = {
      id: 'entry-queue',
      threadId: 'thread-live',
      userId: 'user-1',
      targets: ['codex-sol'],
      enqueuedAt: 1_050,
      claimedAt: 1_250,
      processingStartedAt: 1_250,
      payload: { messageId: 'message-queue' },
    };
    const provider = new FreshnessReplayProviderImpl({
      fixtureRoot,
      queueLifecycleSource: {
        async listOwnerDurableEntries(ownerUserId) {
          return ownerUserId === 'user-1' ? [queueEntry] : [];
        },
      },
      messageLifecycleSource: {
        async listOwnerMessagesInWindow() {
          return [];
        },
      },
      attentionEventLog: {
        async queryWindowBetween() {
          return {
            events: [
              {
                kind: 'held_decision',
                threadId: 'thread-live',
                catId: 'codex-sol',
                invocationId: 'inv-queue',
                timestamp: 1_300,
                toolName: 'cat_cafe_post_message',
                unseenCount: 1,
                reason: 'queued_messages_pending',
              },
            ],
            coverage: { status: 'complete', completeFromMs: 1_000, observedThroughMs: 2_000 },
          };
        },
      },
    });

    const replay = await provider.resolve(selector(), { ownerUserId: 'user-1' });

    assert.equal(replay.report.liveSampleCount, 0);
    assert.equal(replay.report.verdict, 'no_data');
    assert.equal(replay.samples.length, 8);
    assert.equal(replay.measurementMaturity.status, 'ready');
    assert.equal(replay.windowedSignals.queue.entryTargetCount, 1);
    assert.equal(replay.windowedSignals.queue.admittedCount, 1);
    assert.equal(replay.windowedSignals.queue.seenCount, 1);
    assert.equal(replay.windowedSignals.queue.seenUnhandledAtWindowEndCount, 1);
    assert.equal(replay.windowedSignals.attention.counts.held_decision, 1);
    assert.ok(replay.windowedSignals.observedActivityCount > 0);
  });

  it('marks a window immature when the attention index cannot prove full coverage', async () => {
    const provider = new FreshnessReplayProviderImpl({
      fixtureRoot,
      queueLifecycleSource: {
        async listOwnerDurableEntries() {
          return [];
        },
      },
      messageLifecycleSource: {
        async listOwnerMessagesInWindow() {
          return [];
        },
      },
      attentionEventLog: {
        async queryWindowBetween() {
          return {
            events: [],
            coverage: {
              status: 'incomplete',
              completeFromMs: 1_500,
              observedThroughMs: 2_000,
              reason: 'window_starts_before_coverage',
            },
          };
        },
      },
    });

    const replay = await provider.resolve(selector(), { ownerUserId: 'user-1' });

    assert.equal(replay.measurementMaturity.status, 'blocked');
    assert.deepEqual(replay.measurementMaturity.reasons, ['attention_events:window_starts_before_coverage']);
  });
});
