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

function custody(overrides = {}) {
  return {
    version: 1,
    entryId: 'entry-1',
    revision: 1,
    ownerUserId: 'user-1',
    intent: 'respond',
    status: 'processing',
    allTargetCats: ['codex-sol'],
    pendingTargetCats: ['codex-sol'],
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    priority: 'normal',
    createdAt: 900,
    updatedAt: 1_500,
    ...overrides,
  };
}

function queueRecord(queueCustody) {
  return {
    messageId: 'message-1',
    threadId: 'thread-1',
    userId: 'user-1',
    custody: queueCustody,
  };
}

describe('F254 measurement-valid windowed signal projection', () => {
  it('fails source maturity closed without discarding the mandatory structural fixtures', async () => {
    const provider = new FreshnessReplayProviderImpl({
      store: {
        async listUpdatedBetween() {
          return [];
        },
        async listAllSupplements() {
          throw new Error('supplement unavailable');
        },
      },
      fixtureRoot,
      queueLifecycleSource: {
        async listOwnerQueueCustodyLifecycles() {
          throw new Error('queue unavailable');
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
    assert.deepEqual(replay.measurementMaturity.sources.legacy_closures, { status: 'complete' });
    assert.equal(replay.measurementMaturity.sources.queue_custody.status, 'unavailable');
    assert.equal(replay.measurementMaturity.sources.freshness_supplements.status, 'unavailable');
    assert.equal(replay.measurementMaturity.sources.attention_events.status, 'unavailable');
  });

  it('does not mistake a historical failed attempt for the terminal time after retry success', () => {
    const queue = custody({
      revision: 5,
      status: 'terminal',
      pendingTargetCats: [],
      seenByCatIds: ['codex-sol'],
      handledByCatIds: ['codex-sol'],
      targetOutcomeByCatId: {
        'codex-sol': { invocationId: 'inv-2', handledAt: 1_600, disposition: 'completed_with_turn' },
      },
      bodyExposures: [
        { targetCatId: 'codex-sol', invocationId: 'inv-1', seenAt: 1_050 },
        { targetCatId: 'codex-sol', invocationId: 'inv-2', seenAt: 1_500 },
      ],
      targetAttempts: [
        {
          id: 'attempt-1',
          targetCatId: 'codex-sol',
          sequence: 1,
          state: 'failed',
          createdAt: 900,
          updatedAt: 1_100,
        },
        {
          id: 'attempt-2',
          targetCatId: 'codex-sol',
          sequence: 2,
          state: 'handled',
          createdAt: 1_200,
          updatedAt: 1_600,
        },
      ],
      updatedAt: 1_600,
    });

    const signals = buildFreshnessWindowedSignals({
      window,
      queueRecords: [queueRecord(queue)],
      supplements: [],
      attentionEvents: [],
    });

    assert.equal(signals.queue.seenCount, 1);
    assert.equal(signals.queue.handledCount, 1);
    assert.equal(signals.queue.failedCount, 0);
    assert.equal(signals.queue.pendingAtWindowEndCount, 0);
    assert.equal(signals.queue.lifecycles[0].handledAt, 1_600);
    assert.equal(signals.queue.lifecycles[0].failedAt, undefined);
  });

  it('does not let pre-window legacy terminals poison later mature windows', () => {
    const signals = buildFreshnessWindowedSignals({
      window,
      queueRecords: [
        queueRecord(
          custody({
            status: 'terminal',
            pendingTargetCats: [],
            handledByCatIds: ['codex-sol'],
            createdAt: 100,
            updatedAt: 900,
          }),
        ),
      ],
      supplements: [
        {
          id: 'supplement-legacy-old',
          lineageId: 'lineage-old',
          sequence: 1,
          originalMessageId: 'message-old',
          userId: 'user-1',
          threadId: 'thread-1',
          catId: 'codex-sol',
          status: 'committed',
          requiredMessageIds: [],
          requiredFrontierMessageId: 'message-old',
          replayUnsafeToolNames: [],
          revision: 2,
          createdAt: 100,
          updatedAt: 900,
        },
      ],
      attentionEvents: [],
    });

    assert.equal(signals.queue.entryTargetCount, 0);
    assert.equal(signals.queue.legacyUntimedCount, 0);
    assert.equal(signals.supplements.lifecycles.length, 0);
    assert.equal(signals.supplements.legacyUntimedCount, 0);
  });

  it('blocks publication when legacy Queue and Supplement activity overlaps the selected window without exact times', async () => {
    const supplement = {
      id: 'supplement-legacy-current',
      lineageId: 'lineage-current',
      sequence: 1,
      originalMessageId: 'message-current',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'codex-sol',
      status: 'running',
      requiredMessageIds: ['message-update'],
      requiredFrontierMessageId: 'message-update',
      replayUnsafeToolNames: [],
      revision: 2,
      createdAt: 900,
      updatedAt: 1_500,
    };
    const provider = new FreshnessReplayProviderImpl({
      store: {
        async listUpdatedBetween() {
          return [];
        },
        async listAllSupplements() {
          return [supplement];
        },
      },
      fixtureRoot,
      queueLifecycleSource: {
        async listOwnerQueueCustodyLifecycles() {
          return [queueRecord(custody({ seenByCatIds: ['codex-sol'] }))];
        },
      },
      attentionEventLog: {
        async queryWindowBetween() {
          return {
            events: [],
            coverage: { status: 'complete', completeFromMs: 1_000, observedThroughMs: 2_000 },
          };
        },
      },
    });

    const replay = await provider.resolve(
      { kind: 'freshness-closure-replay', windowStartMs: 1_000, windowEndMs: 2_000 },
      { ownerUserId: 'user-1' },
    );

    assert.equal(replay.measurementMaturity.status, 'blocked');
    assert.deepEqual(replay.measurementMaturity.reasons, [
      'queue_custody:legacy_untimed_lifecycles=1',
      'freshness_supplements:legacy_untimed_lifecycles=1',
    ]);
  });
});
