import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retentionInputRefusal } from '../src/domains/cats/services/session/cache/cache-retention-input-boundary.js';
import { retentionProbeAttemptRef } from '../src/domains/cats/services/session/cache/cache-retention-receipt.js';
import type { RetentionWindow } from '../src/domains/cats/services/session/cache/cache-retention-state.js';
import { retentionProbeFixture } from './helpers/f338-retention-probe-fixture.js';

test('F338: real Host transcript/principal path admits a warm SDK maintenance fork', async (t) => {
  const fixture = await retentionProbeFixture(t);
  const before = structuredClone(fixture.record);
  const result = await fixture.run();
  assert.equal(result.outcome, 'sample_pass');
  assert.equal(fixture.counters.modelRequests, 1);
  assert.deepEqual(fixture.record, before, 'maintenance never advances the canonical parent');
});

test('F338: a fresh reader recovers only the exact attempt receipt from the durable Host transcript', async (t) => {
  const f = await retentionProbeFixture(t);
  const receipt = await f.run({ attemptId: 'recoverable', captureReturnBoundary: async () => 1 });
  const restarted = f.restart();
  const scope = {
    userId: 'owner',
    catId: 'haiku55',
    threadId: 'thread',
    sessionId: 'session',
    nativeSessionId: 'native-parent',
    sourceInvocationId: 'source',
    attemptId: 'recoverable',
  };
  assert.deepEqual(await restarted.readReceipt(scope), receipt);
  assert.deepEqual(await restarted.readReceipt(scope), receipt);
  for (const field of [
    'userId',
    'catId',
    'threadId',
    'sessionId',
    'nativeSessionId',
    'sourceInvocationId',
    'attemptId',
  ] as const)
    assert.equal(await restarted.readReceipt({ ...scope, [field]: 'unrelated' }), null, field);
  assert.equal(f.counters.modelRequests, 1, 'receipt recovery never prepares or invokes a provider');
});

test('F338: a recorded attempt with no durable result stays unknown after restart', async (t) => {
  const f = await retentionProbeFixture(t);
  const scope = {
    userId: 'owner',
    catId: 'haiku55',
    threadId: 'thread',
    sessionId: 'session',
    nativeSessionId: 'native-parent',
    sourceInvocationId: 'source',
    attemptId: 'interrupted',
  };
  await f.executions.createRunning({
    invocationId: 'lost-result',
    parentInvocationId: retentionProbeAttemptRef(scope),
    userId: 'owner',
    catId: 'haiku55',
    threadId: 'thread',
    executionKind: 'cache_retention',
    startedAt: Date.now(),
    providerLifecycleTracked: true,
  });
  assert.equal(await f.restart().readReceipt(scope), null);
  assert.equal(f.counters.modelRequests, 0);
});

for (const [label, gap] of [
  ['queued past expiry', 65 * 60_000],
  ['inside the two-minute send margin', 59 * 60_000],
  ['sleep across four cycles', 4 * 3_600_000],
] as const)
  test(`F338: ${label} is durably skipped at actual send with zero model requests`, async (t) => {
    const start = Date.UTC(2026, 10, 18, 23);
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const fixture = await retentionProbeFixture(t, () => t.mock.timers.setTime(start + gap));
    const result = await fixture.run();
    assert.equal(fixture.counters.providerEntries, 1, 'reach the actual provider pre-launch hook');
    assert.equal(fixture.counters.modelRequests, 0, 'an expired maintenance must never pay for a cold write');
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.reason, 'cache_retention_expired_at_send');
    const events = await fixture.reader.readInvocationEvents('session', 'thread', 'haiku55', result.invocationId);
    const terminal = events?.find((entry) => entry.event.type === 'cache_retention_result');
    assert.deepEqual(terminal?.event.receipt, result, 'the skip receipt survives an independent transcript read');
  });

for (const change of ['new source request', 'compression'] as const)
  test(`F338: ${change} during preparation is re-read before sending`, async (t) => {
    const fixture = await retentionProbeFixture(t, (record) => {
      if (change === 'compression') record.compressionCount = 1;
      else {
        const observation = record.lastUsage?.cacheObservation;
        assert.ok(observation);
        record.lastUsage = {
          ...record.lastUsage,
          cacheObservation: { ...observation, invocationId: 'new-source' },
        };
      }
    });
    const result = await fixture.run();
    assert.equal(fixture.counters.modelRequests, 0);
    assert.equal(result.outcome, 'skipped');
    assert.ok(['cache_retention_parent_changed', 'cache_retention_window_unknown'].includes(result.reason ?? ''));
  });

test('F338: a 1000-token tail is measured by same-call cost rather than the retired 512-token cap', async (t) => {
  const fixture = await retentionProbeFixture(t, undefined, { inputTokens: 101_000, cacheCreation1hTokens: 1000 });
  const result = await fixture.run();
  assert.equal(result.outcome, 'sample_pass');
  assert.equal(result.cost?.writeReadRatio, 0.2);
  assert.equal(result.cost?.inputTier, 'haiku_over_100k');
});

test('F338: a maintenance write costing more than half its read fails the canary', async (t) => {
  const fixture = await retentionProbeFixture(t, undefined, { inputTokens: 120_000, cacheCreation1hTokens: 20_000 });
  const result = await fixture.run();
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'cache_retention_sample_failed');
  assert.equal(result.cost?.writeReadRatio, 4);
});

test('F338: SDK internal continuation cannot qualify as a single-request maintenance receipt', async (t) => {
  const fixture = await retentionProbeFixture(t, undefined, { numTurns: 2 });
  const result = await fixture.run();
  assert.equal(result.outcome, 'failed');
  assert.equal(result.reason, 'cache_retention_request_count_unconfirmed');
});

for (const advance of [false, true])
  test(`F338 real probe rechecks frozen input order at provider launch (advance=${advance})`, async (t) => {
    let f: Awaited<ReturnType<typeof retentionProbeFixture>>;
    f = await retentionProbeFixture(t, () => {
      if (!advance) return;
      f.executions.createRunning({
        invocationId: 'no-usage-input',
        parentInvocationId: 'no-usage-input',
        userId: 'owner',
        catId: 'haiku55',
        threadId: 'thread',
        executionKind: 'ordinary',
        providerLifecycleTracked: true,
        startedAt: Date.now(),
      });
      f.executions.markProviderStarted('no-usage-input', Date.now());
    });
    const source = f.record.lastUsage!.cacheObservation!;
    f.executions.createRunning({
      invocationId: source.invocationId,
      parentInvocationId: source.invocationId,
      userId: 'owner',
      catId: 'haiku55',
      threadId: 'thread',
      executionKind: 'ordinary',
      providerLifecycleTracked: true,
      startedAt: source.requestStartedAt,
    });
    f.executions.markProviderStarted(source.invocationId, source.requestStartedAt);
    f.executions.recordProviderTeardown(source.invocationId, source.observedAt);
    f.executions.transitionTerminal(source.invocationId, {
      status: 'succeeded',
      endedAt: source.observedAt,
      terminalReason: 'fixture-source-complete',
    });
    const window: RetentionWindow = {
      id: 'window',
      revision: 1,
      userId: 'owner',
      catId: 'haiku55',
      threadId: 'thread',
      sessionId: f.record.id,
      nativeSessionId: f.record.cliSessionId!,
      source,
      sourceInputSequence: 1,
      preferenceRevision: 1,
      dueAt: Date.now(),
      retainUntil: Date.now() + 3_600_000,
      state: 'waiting',
      receipts: [],
    };
    const assertCurrent = async () => {
      const refusal = await retentionInputRefusal(window, f.executions.cacheFacts);
      if (refusal) throw new Error(refusal);
    };
    const result = await f.run({
      assertCurrent,
      captureReturnBoundary: async () => {
        await assertCurrent();
        return 1;
      },
    });
    assert.equal(f.counters.providerEntries, 1);
    assert.equal(f.counters.modelRequests, advance ? 0 : 1);
    assert.equal(result.outcome, advance ? 'skipped' : 'sample_pass');
    assert.equal(result.returnAfterSequence, 1);
  });
