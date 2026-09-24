import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const { buildFreshnessWindowedSignals } = await import(
  '../dist/infrastructure/harness-eval/freshness/freshness-windowed-signal-report.js'
);
const { FreshnessReplayProviderImpl } = await import(
  '../dist/infrastructure/harness-eval/freshness/freshness-replay-provider.js'
);

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const fixtureRoot = `${repoRoot}/docs/harness-feedback/fixtures/f254`;
const window = { startMs: 1_000, endMs: 2_000 };

function queueRecord(overrides = {}) {
  return {
    entryId: 'entry-1',
    targetCatId: 'codex-sol',
    threadId: 'thread-1',
    messageId: 'message-1',
    createdAt: 900,
    lastUpdatedAt: 1_500,
    firstSeenAt: 1_050,
    terminalState: false,
    legacyUntimed: false,
    ...overrides,
  };
}

describe('F254 measurement-valid windowed signal projection', () => {
  it('fails source maturity closed without discarding mandatory structural fixtures', async () => {
    const provider = new FreshnessReplayProviderImpl({
      fixtureRoot,
      queueLifecycleSource: {
        async listOwnerDurableEntries() {
          throw new Error('queue unavailable');
        },
      },
      messageLifecycleSource: {
        async listOwnerMessagesInWindow() {
          throw new Error('history unavailable');
        },
      },
      attentionEventLog: {
        async queryWindowBetween() {
          throw new Error('attention unavailable');
        },
      },
    });

    const replay = await provider.resolve(
      { kind: 'freshness-closure-replay', windowStartMs: 1_000, windowEndMs: 2_000 },
      { ownerUserId: 'user-1' },
    );
    assert.equal(replay.samples.length, 8);
    assert.equal(replay.measurementMaturity.status, 'blocked');
    assert.equal(replay.measurementMaturity.sources.queue_custody.status, 'unavailable');
    assert.equal(replay.measurementMaturity.sources.attention_events.status, 'unavailable');
  });

  it('does not mistake a historical failed attempt for terminal time after retry success', () => {
    const signals = buildFreshnessWindowedSignals({
      window,
      queueRecords: [queueRecord({ lastUpdatedAt: 1_600, firstSeenAt: 1_500, handledAt: 1_600, terminalState: true })],
      attentionEvents: [],
    });
    assert.equal(signals.queue.seenCount, 1);
    assert.equal(signals.queue.handledCount, 1);
    assert.equal(signals.queue.failedCount, 0);
    assert.equal(signals.queue.pendingAtWindowEndCount, 0);
    assert.equal(signals.queue.lifecycles[0].handledAt, 1_600);
    assert.equal(signals.queue.lifecycles[0].failedAt, undefined);
  });

  it('does not let pre-window terminals poison later mature windows', () => {
    const signals = buildFreshnessWindowedSignals({
      window,
      queueRecords: [queueRecord({ createdAt: 100, lastUpdatedAt: 900, handledAt: 900, terminalState: true })],
      attentionEvents: [],
    });
    assert.equal(signals.queue.entryTargetCount, 0);
    assert.equal(signals.queue.legacyUntimedCount, 0);
  });

  it('blocks publication when an untimed History dispatch overlaps the window', async () => {
    const provider = new FreshnessReplayProviderImpl({
      fixtureRoot,
      queueLifecycleSource: {
        async listOwnerDurableEntries() {
          return [];
        },
      },
      messageLifecycleSource: {
        async listOwnerMessagesInWindow() {
          return [
            {
              id: 'message-current',
              threadId: 'thread-1',
              userId: 'user-1',
              timestamp: 900,
              lifecycle: {
                kind: 'input',
                orderKey: 'entry-current',
                dispatchRefs: [{ targetId: 'codex-sol', statusMessageId: 'response-missing' }],
              },
            },
          ];
        },
      },
      attentionEventLog: {
        async queryWindowBetween() {
          return { events: [], coverage: { status: 'complete', completeFromMs: 1_000, observedThroughMs: 2_000 } };
        },
      },
    });
    const replay = await provider.resolve(
      { kind: 'freshness-closure-replay', windowStartMs: 1_000, windowEndMs: 2_000 },
      { ownerUserId: 'user-1' },
    );
    assert.equal(replay.measurementMaturity.status, 'blocked');
    assert.deepEqual(replay.measurementMaturity.reasons, ['queue_custody:legacy_untimed_lifecycles=1']);
  });
});
