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
