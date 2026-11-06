import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRevision } from '../../dist/domains/memory/message-query-protocol.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';
import { privateMessageSearchTrace } from '../../dist/domains/memory/message-search-trace.js';

const candidates = ['a', 'b'].map((id) => ({
  threadId: 'PRIVATE-THREAD',
  messageId: `PRIVATE-MESSAGE-${id}`,
  content: `PRIVATE-BODY-${id}: a replacement was discussed`,
  contentRevision: contentRevision(`PRIVATE-BODY-${id}: a replacement was discussed`),
}));

for (const external of [false, true]) {
  test(`sealed provider result ${external ? 'cannot survive request cancellation' : 'survives local expiry only after normal teardown'}`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
    const client = new AbortController();
    let finish;
    let settled = false;
    const traces = [];
    const qualifier = new MessageQueryQualifier(async (batch, ctx) => {
      const text = JSON.stringify({ requestId: batch.requestId, rows: [[batch.rows[0].id, 'rejected', null]] });
      ctx.onResult?.(text);
      await new Promise((resolve) => {
        finish = resolve;
      });
      ctx.onTrace({ phase: 'native-completed' });
      return text;
    });
    const pending = qualifier
      .qualify('PRIVATE-QUERY', candidates.slice(0, 1), {
        userId: 'owner',
        deadlineAt: Date.now() + 3000,
        signal: client.signal,
        onTrace: (trace) => traces.push(trace),
      })
      .finally(() => {
        settled = true;
      });
    const checked = external ? assert.rejects(pending, { name: 'AbortError' }) : pending;
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(settled, false, 'Host capacity and publication wait for actual runner teardown');
    if (external) client.abort(new DOMException('request closed', 'AbortError'));
    finish();
    const result = await checked;
    if (!external) {
      assert.equal(result.meta.rejected, 1);
      assert.equal(result.meta.unassessed, 0);
      assert.deepEqual(result.meta.batches, { started: 1, completed: 1, cancelled: 0, failed: 0 });
      assert.ok(traces.find((x) => x.phase === 'qualification').batches[0].abortAfterMs >= 0);
    }
  });
}

for (const scenario of ['late result', 'changed result', 'hard expiry']) {
  test(`${scenario} cannot publish a sealed batch across the work deadline`, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
    let release;
    const qualifier = new MessageQueryQualifier(async (batch, ctx) => {
      const text = JSON.stringify({ requestId: batch.requestId, rows: [[batch.rows[0].id, 'rejected', null]] });
      if (scenario !== 'late result') assert.equal(ctx.onResult(text), true);
      await new Promise((resolve) => {
        release = resolve;
      });
      if (scenario === 'late result') assert.equal(ctx.onResult(text), false);
      return scenario === 'changed result' ? `${text} ` : text;
    });
    const pending = qualifier.qualify('PRIVATE-QUERY', candidates.slice(0, 1), {
      userId: 'owner',
      deadlineAt: Date.now() + 3000,
    });
    const checked = scenario === 'hard expiry' ? assert.rejects(pending, { name: 'TimeoutError' }) : pending;
    t.mock.timers.tick(scenario === 'hard expiry' ? 3000 : 1000);
    release();
    const result = await checked;
    if (scenario !== 'hard expiry') {
      assert.equal(result.meta.unassessed, 1);
      assert.equal(result.meta.rejected, 0);
      assert.equal(result.meta.batches.cancelled, 1);
    }
  });
}

test('native completion diagnostics expose only bounded status and exit facts', () => {
  const fields = {
    resultStatus: 'success',
    exitCode: 0,
    exitSignal: 'none',
    processClosed: true,
    deadlineAfterResult: true,
  };
  const privateFields = { result: 'PRIVATE-OUTPUT', thinking: 'PRIVATE-THINKING', requestId: 'PRIVATE-ID' };
  assert.deepEqual(privateMessageSearchTrace({ phase: 'native-terminal', ...fields, ...privateFields }), {
    phase: 'native-terminal',
    ...fields,
  });
  const nested = privateMessageSearchTrace({ phase: 'qualification', batches: [{ ...fields, ...privateFields }] });
  assert.deepEqual(nested.batches, [fields]);
  assert.deepEqual(
    privateMessageSearchTrace({
      phase: 'native-closed',
      exitCode: '0',
      exitSignal: 'PRIVATE',
      resultStatus: 'PRIVATE',
    }),
    {
      phase: 'native-closed',
    },
  );
});

test('elapsed work time cannot be bypassed while the timeout callback is still queued', async (t) => {
  const now = 1_700_000_000_000;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now });
  const qualifier = new MessageQueryQualifier(async (batch, ctx) => {
    const text = JSON.stringify({ requestId: batch.requestId, rows: [[batch.rows[0].id, 'rejected', null]] });
    t.mock.timers.setTime(now + 1001);
    assert.equal(ctx.signal.aborted, false, 'setTime advances the wall clock without executing the timer');
    assert.equal(ctx.onResult(text), false, 'the original work cutoff still rejects the result');
    return text;
  });
  const result = await qualifier.qualify('PRIVATE-QUERY', candidates.slice(0, 1), {
    userId: 'owner',
    deadlineAt: now + 3000,
  });
  assert.equal(result.meta.unassessed, 1);
  assert.equal(result.meta.rejected, 0);
});

test('a timed-out runner keeps its existing Host slot until owned close is proven', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  let close;
  const closed = new Promise((resolve) => {
    close = resolve;
  });
  const first = new MessageQueryQualifier(async (_batch, ctx) => {
    ctx.onTeardown?.(closed);
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    throw ctx.signal.reason;
  }).qualify('PRIVATE-QUERY', candidates.slice(0, 1), { userId: 'owner', deadlineAt: Date.now() + 3000 });
  t.mock.timers.tick(1000);
  assert.equal((await first).meta.unassessed, 1);
  let finish;
  const second = new MessageQueryQualifier(async (batch) => {
    await new Promise((resolve) => {
      finish = resolve;
    });
    return JSON.stringify({ requestId: batch.requestId, rows: [] });
  }).qualify('PRIVATE-QUERY', candidates.slice(0, 1), { userId: 'owner', deadlineAt: Date.now() + 3000 });
  try {
    const third = await new MessageQueryQualifier(async () => assert.fail('started before owned close')).qualify(
      'PRIVATE-QUERY',
      candidates.slice(0, 1),
      { userId: 'owner', deadlineAt: Date.now() + 3000 },
    );
    assert.equal(third.nativeCalls, 0);
  } finally {
    close();
    finish();
    await second;
  }
  const afterClose = await new MessageQueryQualifier(async (batch) =>
    JSON.stringify({ requestId: batch.requestId, rows: [] }),
  ).qualify('PRIVATE-QUERY', candidates.slice(0, 1), { userId: 'owner', deadlineAt: Date.now() + 3000 });
  assert.equal(afterClose.nativeCalls, 1);
});

test('successful partial retains both runner abort/cleanup summaries after teardown, without approving unknown rows', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_700_000_000_000 });
  const traces = [];
  let stopped = 0;
  const qualifier = new MessageQueryQualifier(async (_batch, ctx) => {
    ctx.onTrace({ phase: 'native-launch' });
    ctx.onTrace({ phase: 'native-response', model: 'claude-haiku-5-5' });
    await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stopped++;
    throw ctx.signal.reason;
  });
  let returned = false;
  const pending = qualifier
    .qualify('PRIVATE-QUERY', candidates, {
      userId: 'PRIVATE-OWNER',
      deadlineAt: Date.now() + 3000,
      onTrace: (trace) => traces.push(privateMessageSearchTrace(trace)),
    })
    .then((result) => {
      returned = true;
      return result;
    });
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(returned, false, 'neither HTTP publication nor observation may outrun runner cleanup');
  assert.equal(stopped, 0);
  t.mock.timers.tick(20);
  const result = await pending;
  assert.equal(stopped, 2);
  assert.equal(result.meta.status, 'partial');
  assert.equal(result.meta.unassessed, 2);
  assert.equal(result.meta.supported, 0);
  assert.equal(result.meta.rejected, 0);
  const summary = traces.find((trace) => trace.phase === 'qualification');
  assert.equal(summary.runnerCalls, 2, 'successful partial must keep the existing request-local lifecycle evidence');
  assert.equal(summary.nativeLaunches, 2);
  assert.equal(summary.costReports, 0);
  assert.equal(summary.reportedCostUsd, null, 'absence of a provider cost receipt remains unknown');
  assert.equal(summary.batches.length, 2);
  for (const batch of summary.batches) {
    assert.equal(batch.stage, 'native-response', 'response is only a stage, not successful qualification');
    assert.equal(batch.outcome, 'aborted');
    assert.equal(batch.rows, 1);
    assert.ok(batch.runMs >= 0);
    assert.ok(batch.abortAfterMs >= 0);
    assert.ok(batch.cleanupAfterAbortMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE-/);
  assert.equal(result.messageSearchQualification, undefined, 'internal evidence never becomes the public result');
});

test('qualification trace bounds and allow-lists lifecycle evidence instead of retaining runner payloads', () => {
  const batch = {
    rows: 2,
    bodyChars: 40,
    remainingMs: 12000,
    stage: 'native-response',
    runMs: 100,
    abortAfterMs: 80,
    cleanupAfterAbortMs: 20,
    outcome: 'aborted',
    query: 'PRIVATE-QUERY',
    body: 'PRIVATE-BODY',
    userId: 'PRIVATE-OWNER',
  };
  const safe = privateMessageSearchTrace({
    phase: 'qualification',
    runnerCalls: 2,
    nativeLaunches: 2,
    costReports: 0,
    reportedCostUsd: null,
    batches: [batch, { ...batch, stage: 'PRIVATE-STAGE', outcome: 'PRIVATE-OUTCOME', runMs: Infinity }, batch],
  });
  assert.equal(safe.batches.length, 2);
  assert.equal(safe.batches[0].stage, 'native-response');
  assert.equal(safe.batches[0].outcome, 'aborted');
  assert.equal(safe.batches[1].stage, undefined);
  assert.equal(safe.batches[1].outcome, undefined);
  assert.equal(safe.batches[1].runMs, undefined);
  assert.doesNotMatch(JSON.stringify(safe), /PRIVATE-/);
  assert.equal(safe.reportedCostUsd, null);
  const objectOutcome = privateMessageSearchTrace({
    phase: 'qualification',
    batches: [{ outcome: { toString: () => 'aborted', body: 'PRIVATE-BODY' } }],
  });
  assert.deepEqual(objectOutcome.batches, [{}], 'string-like objects cannot smuggle raw payloads');
});

for (const valid of [true, false]) {
  test(`${valid ? 'complete' : 'failed protocol'} qualification keeps actual outcome and an explicit zero cost receipt`, async () => {
    const traces = [];
    const qualifier = new MessageQueryQualifier(async (batch, ctx) => {
      ctx.onTrace({ phase: 'native-launch' });
      ctx.onTrace({ phase: 'native-usage', costUsd: 0 });
      return valid
        ? JSON.stringify({ requestId: batch.requestId, rows: batch.rows.map((row) => [row.id, 'supported', row.body]) })
        : 'not-json';
    });
    const result = await qualifier.qualify('PRIVATE-QUERY', candidates, {
      userId: 'PRIVATE-OWNER',
      deadlineAt: Date.now() + 5000,
      onTrace: (trace) => traces.push(privateMessageSearchTrace(trace)),
    });
    const summary = traces.find((trace) => trace.phase === 'qualification');
    assert.equal(result.meta.status, valid ? 'complete' : 'partial');
    assert.equal(result.meta.supported, valid ? 2 : 0);
    assert.equal(result.meta.unassessed, valid ? 0 : 2);
    assert.equal(summary.runnerCalls, 2);
    assert.equal(summary.costReports, 2);
    assert.equal(summary.reportedCostUsd, 0);
    assert.deepEqual(
      summary.batches.map((batch) => batch.outcome),
      Array(2).fill(valid ? 'completed' : 'failed'),
    );
    assert.doesNotMatch(JSON.stringify(summary), /PRIVATE-/);
  });
}
