import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { base, minute } from './helpers/f338-retention-coordinator-fixture.js';
import { multiRetentionFixture } from './helpers/f338-retention-multi-fixture.js';
import { redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

const opts = { skip: redisIsolationSkipReason(process.env.REDIS_URL) };
async function withinPreparation(work: Promise<void>) {
  const timeout = new AbortController();
  try {
    await Promise.race([work, delay(1500, undefined, { signal: timeout.signal })]);
  } finally {
    timeout.abort();
  }
}
test('F338: three independent 75-second probes start before any previous result is needed', opts, async (t) => {
  const f = await multiRetentionFixture(t);
  const starts: number[] = [],
    releases: Array<() => void> = [];
  let allStarted!: () => void,
    cleaning = false;
  const started = new Promise<void>((resolve) => {
    allStarted = resolve;
  });
  f.afterSend(async (input) => {
    starts.push(f.now());
    if (starts.length === 3) allStarted();
    if (cleaning) return;
    await new Promise<void>((resolve) => {
      releases.push(resolve);
      input.signal.addEventListener('abort', resolve, { once: true });
    });
    input.signal.throwIfAborted();
  });
  f.time(50);
  let dispatched = false;
  const sweep = f.coordinator.tick().then(() => {
    dispatched = true;
  });
  try {
    await withinPreparation(started);
    assert.equal(starts.length, 3, 'independent due windows must not wait for a slow model result');
    assert.deepEqual(starts, Array(3).fill(base + 50 * minute));
    await withinPreparation(sweep);
    assert.equal(dispatched, true, 'a poll must finish dispatch before model results arrive');
    assert.ok((await f.store.recent()).every((window) => window.state === 'retaining'));
    f.time(50.5);
    await f.coordinator.tick();
    assert.equal(f.queries(), 3, 'another poll cannot replay owned in-flight claims');
    f.time(51.25); // 75 seconds of normal provider time, all requests already started.
    releases.forEach((resolve) => resolve());
    await f.coordinator.settleActive();
    assert.equal(f.queries(), 3);
    const windows = await f.store.recent();
    assert.ok(windows.every((window) => window.receipts.length === 1 && window.dueAt === base + 100 * minute));
    assert.equal(new Set(windows.map((window) => window.receipts[0]?.invocationId)).size, 3);
  } finally {
    cleaning = true;
    releases.forEach((resolve) => resolve());
    await sweep;
    await f.coordinator.settleActive();
  }
});

for (const change of ['returned_without_usage', 'disabled'] as const)
  test(`F338: a preparing session can ${change} while independent slow probes continue`, opts, async (t) => {
    const f = await multiRetentionFixture(t),
      target = f.contexts[2]!;
    let prepared!: () => void, othersStarted!: () => void, releasePrepare!: () => void;
    const preparing = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const others = new Promise<void>((resolve) => {
      othersStarted = resolve;
    });
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const releaseOthers: Array<() => void> = [];
    f.beforeSend(async (input) => {
      if (input.threadId === target.record.threadId) {
        prepared();
        await prepareGate;
      }
    });
    f.afterSend(async (input) => {
      await new Promise<void>((resolve) => {
        releaseOthers.push(resolve);
        input.signal.addEventListener('abort', resolve, { once: true });
        if (releaseOthers.length === 2) othersStarted();
      });
      input.signal.throwIfAborted();
    });
    f.time(50);
    const sweep = f.coordinator.tick();
    try {
      await withinPreparation(Promise.all([preparing, others]).then(() => {}));
      assert.equal(releaseOthers.length, 2);
      await sweep;
      f.time(50.5);
      if (change === 'disabled') {
        await f.settings.set('owner', target.record.catId, false);
        await f.coordinator.preferenceChanged('owner', target.record.catId);
      } else {
        await f.executions.createRunning({
          invocationId: 'real-return',
          parentInvocationId: 'real-return',
          userId: 'owner',
          catId: target.record.catId,
          threadId: target.record.threadId,
          executionKind: 'ordinary',
          providerLifecycleTracked: true,
          startedAt: f.now(),
        });
        await f.executions.markProviderStarted('real-return', f.now());
        await f.executions.recordProviderTeardown('real-return', f.now());
        await f.executions.transitionTerminal('real-return', {
          status: 'succeeded',
          endedAt: f.now(),
          terminalReason: 'fixture',
        });
      }
      releasePrepare();
      f.time(51.25);
      releaseOthers.forEach((resolve) => resolve());
      await f.coordinator.settleActive();
      assert.equal(f.queries(), 2, 'the changed session reaches no model input');
      const windows = await f.store.recent();
      assert.equal(windows.find((window) => window.threadId === target.record.threadId)?.state, 'stopped');
      assert.equal(windows.filter((window) => window.receipts.length === 1).length, 2);
      f.time(75);
      await f.coordinator.tick();
      await f.coordinator.settleActive();
      assert.equal(f.queries(), 2);
    } finally {
      releasePrepare();
      releaseOthers.forEach((resolve) => resolve());
      await sweep;
      await f.coordinator.close();
    }
  });

test('F338: shutdown cancels and joins every owned slow maintenance without retrying', opts, async (t) => {
  const f = await multiRetentionFixture(t);
  let entered = 0,
    ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  f.afterSend(async (input) => {
    entered++;
    if (entered === 3) ready();
    await new Promise<void>((resolve) => input.signal.addEventListener('abort', resolve, { once: true }));
    input.signal.throwIfAborted();
  });
  f.time(50);
  await f.coordinator.tick();
  await withinPreparation(started);
  assert.equal(entered, 3);
  await f.coordinator.close();
  await f.coordinator.settleActive();
  assert.ok(
    (await f.store.recent()).every((window) => window.state === 'stopped' && window.attempt?.completed === false),
  );
  await f.coordinator.tick();
  assert.equal(f.queries(), 3);
});

test('F338: disabling a member cancels all its owned jobs outside the recent-window view', opts, async (t) => {
  const f = await multiRetentionFixture(t),
    target = f.contexts[2]!;
  const signals = new Map<string, AbortSignal>(),
    release: Array<() => void> = [];
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  f.afterSend(async (input) => {
    signals.set(input.threadId, input.signal);
    if (signals.size === 3) ready();
    await new Promise<void>((resolve) => {
      release.push(resolve);
      input.signal.addEventListener('abort', resolve, { once: true });
    });
    input.signal.throwIfAborted();
  });
  const recent = f.store.recent.bind(f.store);
  f.time(50);
  try {
    await f.coordinator.tick();
    await withinPreparation(started);
    assert.equal(signals.size, 3);
    f.store.recent = async () => []; // UI/history pagination cannot be the cancellation authority.
    await f.settings.set('owner', target.record.catId, false);
    await f.coordinator.preferenceChanged('owner', target.record.catId);
    assert.equal(signals.get(target.record.threadId)?.aborted, true);
    assert.ok(f.contexts.slice(0, 2).every((context) => signals.get(context.record.threadId)?.aborted === false));
  } finally {
    f.store.recent = recent;
    release.forEach((resolve) => resolve());
    await f.coordinator.close();
  }
});
