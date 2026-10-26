import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageSearchService } from '../../dist/domains/memory/MessageSearchService.js';
import { MessageQueryQualifier } from '../../dist/domains/memory/message-query-qualifier.js';
import { MessageSearchDiagnostics } from '../../dist/domains/memory/message-search-diagnostics.js';
import { privateMessageSearchTrace } from '../../dist/domains/memory/message-search-trace.js';

const candidate = (id) => ({
  docAnchor: 'thread-neutral',
  passageId: `msg-${id}`,
  threadId: 'neutral',
  messageId: id,
  content: 'private-body',
  match: 'lexical',
});
const principal = { userId: 'owner', viewer: { type: 'user' } };

test('parallel requests keep successful worker snapshots isolated and late observers cannot leak into a new request', async () => {
  const callbacks = new Map();
  const traces = { a: [], b: [], c: [] };
  let releaseA;
  const holdA = new Promise((resolve) => {
    releaseA = resolve;
  });
  const reason = new DOMException('controlled late failure', 'TimeoutError');
  const service = new MessageSearchService({
    qualifier: new MessageQueryQualifier(async () => {
      assert.fail('fixture must not invoke a model');
    }),
    threadStore: { list: () => [{ id: 'neutral', createdBy: 'owner' }] },
    messageStore: {
      getById: async (id) => {
        if (id === 'a') {
          await holdA;
          throw reason;
        }
        return null;
      },
    },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages: async (query, options) => {
        callbacks.set(query, options.onReadSnapshot);
        if (query !== 'c')
          options.onReadSnapshot({
            executionId: `job-${query}`,
            outcome: 'fulfilled',
            pid: query === 'a' ? 123 : 456,
            cjk: null,
          });
        return { passages: [candidate(query)], meta: { effectiveMode: 'lexical', candidateLimit: 2000 } };
      },
    },
  });
  const a = service.search({ query: 'a', mode: 'lexical' }, principal, { onTrace: (t) => traces.a.push(t) });
  const b = await service.search({ query: 'b', mode: 'lexical' }, principal, { onTrace: (t) => traces.b.push(t) });
  assert.deepEqual(b.results, []);
  releaseA();
  await assert.rejects(a, (error) => {
    assert.equal(error, reason);
    assert.deepEqual(
      error.messageSearchExecution.workerReads.map((w) => w.executionId),
      ['job-a'],
    );
    return true;
  });
  callbacks.get('a')({ executionId: 'LEAK', outcome: 'fulfilled' });
  const c = await service.search({ query: 'c', mode: 'lexical' }, principal, { onTrace: (t) => traces.c.push(t) });
  assert.deepEqual(c.results, []);
  assert.deepEqual(
    traces.b.find((t) => t.phase === 'retrieval').workerReads.map((w) => w.executionId),
    ['job-b'],
  );
  assert.deepEqual(traces.c.find((t) => t.phase === 'retrieval').workerReads, []);
  assert.doesNotMatch(JSON.stringify(traces), /LEAK|private-body/);
});

test('trace allow-list, event cap, zero-cost receipt and unknown usage remain private and bounded', () => {
  const traces = [];
  const d = new MessageSearchDiagnostics((t) => traces.push(t));
  for (let i = 0; i < 100; i++)
    d.trace({
      phase: 'native-usage',
      costUsd: 0,
      usage: { input_tokens: 3, body: 'PRIVATE-BODY', userId: 'PRIVATE-USER' },
      query: 'PRIVATE-QUERY',
      modelUsage: { neutral: { inputTokens: 3, prompt: 'PRIVATE-PROMPT' } },
    });
  assert.equal(traces.length, 32);
  assert.equal(traces[0].costUsd, 0);
  assert.equal(traces[0].usage.input_tokens, 3);
  assert.doesNotMatch(JSON.stringify(traces), /PRIVATE/);
  assert.equal(privateMessageSearchTrace({ phase: 'native-usage' }).costUsd, undefined);
  const hostile = {
    get phase() {
      throw new Error('observer down');
    },
  };
  assert.equal(privateMessageSearchTrace(hostile), undefined);
  d.close();
  d.trace({ phase: 'retrieval' });
  d.worker({ executionId: 'late' });
  assert.equal(traces.length, 32);
  assert.deepEqual(d.snapshot().workerReads, []);
});

test('overlapping operation time is explicitly a settled sum and late work cannot alter a closed snapshot', async () => {
  const d = new MessageSearchDiagnostics();
  let release;
  const held = new Promise((r) => {
    release = r;
  });
  const one = d.measure('source', async () => {
    await held;
    return 1;
  });
  const two = d.measure('source', async () => {
    await held;
    return 2;
  });
  assert.equal(d.snapshot().canonical.operations.source.started, 2);
  assert.equal(d.snapshot().canonical.operations.source.fulfilled, 0);
  release();
  assert.deepEqual(await Promise.all([one, two]), [1, 2]);
  const s = d.snapshot();
  assert.equal(s.canonical.operations.source.fulfilled, 2);
  assert.ok(s.canonical.operations.source.elapsedMs >= 0);
  let late;
  const work = d.measure(
    'source',
    () =>
      new Promise((r) => {
        late = r;
      }),
  );
  d.close();
  const atClose = d.snapshot();
  late(3);
  await work;
  assert.deepEqual(d.snapshot(), atClose);
});

test('CJK observer caps IPC independent of visited bodies and preserves callback results under a throwing sink', async () => {
  const { observeCjkRead } = await import('../../dist/domains/memory/message-cjk-read-diagnostics.js');
  const events = [];
  const d = observeCjkRead((s) => events.push(s));
  const match = d.wrap(() => 7);
  const result = d.read(() => {
    for (let i = 0; i < 4_300_000; i++) assert.equal(match('甲'), 7);
    return [1];
  });
  assert.deepEqual(result, [1]);
  assert.equal(events.length, 9);
  assert.equal(events.at(-1).checkpoints, 8);
  assert.equal(events.at(-1).bodyVisits, 4_300_000);
  const failed = observeCjkRead(() => {
    throw new Error('observer down');
  });
  const f = failed.wrap(() => 9);
  assert.deepEqual(
    failed.read(() => [f('甲')]),
    [9],
  );
  const reason = new Error('original SQLite callback failure');
  assert.throws(
    () =>
      failed.read(() => {
        throw reason;
      }),
    (e) => e === reason,
  );
});

test('ordinary canonical search attributes all five actual operations without changing literal results', async () => {
  const thread = { id: 'neutral', createdBy: 'owner', title: 'Neutral' };
  const body = '中性柚子材料';
  const traces = [];
  const service = new MessageSearchService({
    qualifier: new MessageQueryQualifier(async () => {
      assert.fail('literal witness must not invoke a model');
    }),
    threadStore: { get: () => thread, list: () => [thread] },
    messageStore: {
      getById: async (id) => ({
        id,
        threadId: 'neutral',
        userId: 'owner',
        from: { kind: 'user', userId: 'owner' },
        content: body,
        timestamp: 1000,
      }),
    },
    evidenceStore: {
      readMessagePassageState: () => ({ current: true }),
      searchMessagePassages: () => ({
        passages: [{ ...candidate('one'), content: body }],
        meta: { effectiveMode: 'lexical', candidateLimit: 2000 },
      }),
    },
  });
  const result = await service.search({ query: body, mode: 'lexical' }, principal, {
    onTrace: (t) => traces.push(t),
  });
  assert.equal(result.results[0].messageId, 'one');
  const d = traces.find((t) => t.phase === 'canonical-projection').canonical;
  assert.equal(d.inputCandidates, 1);
  assert.equal(d.acceptedRows, 1);
  assert.equal(d.waves.started, 1);
  assert.equal(d.waves.fulfilled, 1);
  assert.equal(d.waves.maxWidth, 1);
  for (const key of ['source', 'thread', 'access', 'state', 'projection']) {
    assert.equal(d.operations[key].started, 1);
    assert.equal(d.operations[key].fulfilled, 1);
    assert.equal(d.operations[key].rejected, 0);
    assert.ok(d.operations[key].elapsedMs >= 0);
  }
  assert.doesNotMatch(JSON.stringify(traces), /中性柚子|owner/);
  assert.equal(result.meta.qualification.nativeCalls, undefined);
});
