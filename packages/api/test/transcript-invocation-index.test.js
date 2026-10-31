import assert from 'node:assert/strict';
import { appendFile, chmod, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectInvocationTrajectories } from '../dist/domains/cats/services/session/InvocationTrajectoryProjector.js';
import { InvocationSummaryAccumulator } from '../dist/domains/cats/services/session/transcript-index/InvocationSummaryAccumulator.js';
import { compactTranscriptEvent } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-compact-event.js';
import { readTranscriptInvocationIndex } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-index-worker.js';

const session = { id: 'session', threadId: 'thread', catId: 'cat', seq: 2, status: 'active' };
const event = (id, n, payload, t = 1000 + n) => ({
  v: 1,
  t,
  threadId: 'thread',
  catId: 'cat',
  sessionId: 'session',
  invocationId: id,
  eventNo: n,
  event: payload,
});
const jsonl = (events, ending = '\n') => events.map((value) => JSON.stringify(value)).join(ending) + ending;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'transcript-index-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = { session, directory, buffered: [], includeLive: true };
  const read = (query = { kind: 'list', limit: 200 }) => readTranscriptInvocationIndex({ sessions: [input], query });
  return { directory, input, read };
}

test('compact incremental summaries match the existing projector for counts, terminals, tokens, and text', () => {
  const events = [
    event('a', 0, { type: 'text', content: 'first'.repeat(100) }),
    event('b', 1, { type: 'done', metadata: { usage: { inputTokens: 0 } } }),
    event('a', 2, {
      type: 'assistant',
      content: [
        { type: 'text', text: '二' },
        { type: 'text', text: '三' },
      ],
    }),
    event('a', 3, { type: 'status', content: 'huge ignored payload'.repeat(1000) }),
    event('a', 4, { type: 'tool_use', name: 'Read' }),
    event('a', 5, { type: 'tool_use', toolName: 'Read' }),
    event('a', 6, { type: 'tool_result', toolResultStatus: 'error', content: 'x'.repeat(10000) }),
    event('a', 7, { type: 'error', error: 'temporary', errorDisposition: 'transient' }),
    event('a', 8, { type: 'error', error: 'first terminal error' }),
    event('a', 9, { type: 'system_info', content: JSON.stringify({ type: 'timeout_diagnostics', extra: 'large' }) }),
    event('a', 10, { type: 'error', errorCode: 'cancelled' }),
    event('a', 11, { type: 'done', metadata: { usage: { inputTokens: 3, outputTokens: 4, cacheReadTokens: 0 } } }),
    event('a', 12, { type: 'user', content: 'fourth' }),
  ];
  const accumulator = new InvocationSummaryAccumulator(session);
  for (const item of events) accumulator.add(compactTranscriptEvent(item).projection);
  assert.deepEqual([...accumulator.values()], projectInvocationTrajectories(events, session));
});

test('persistent summaries survive a new reader and warm reads never hydrate or rescan payloads', async (t) => {
  const f = await fixture(t);
  const events = [
    event('large', 0, { type: 'tool_result', content: 'x'.repeat(1_000_000) }),
    event('small', 1, { type: 'done' }),
  ];
  await writeFile(join(f.directory, 'events.jsonl'), jsonl(events, '\r\n'));
  const cold = await f.read({ kind: 'list', limit: 1 });
  assert.equal(cold.total, 2);
  assert.equal(cold.invocations[0].invocationId, 'small');
  assert.ok(cold.diagnostics.sourceBytesScanned > 1_000_000);
  assert.equal(cold.diagnostics.hydratedBytes, 0);
  const warm = await f.read({ kind: 'list', limit: 1 });
  assert.deepEqual(warm.invocations, cold.invocations);
  assert.equal(warm.diagnostics.sourceBytesScanned, 0);
  assert.equal(warm.diagnostics.summaryCacheHits, 1);
  const detail = await f.read({ kind: 'invocation', invocationId: 'small', limit: 1 });
  assert.equal(detail.diagnostics.sourceBytesScanned, 0);
  assert.ok(detail.diagnostics.hydratedBytes < 500);
  assert.deepEqual(detail.pages[0].events, [{ event: events[1] }]);
});

test('live appends scan only the suffix and a partial final line is correctly revisited', async (t) => {
  const f = await fixture(t);
  const first = event('first', 0, { type: 'text', content: 'prefix'.repeat(2000) });
  await writeFile(join(f.directory, 'events.live.jsonl'), jsonl([first]));
  await f.read();
  const second = event('second', 1, { type: 'text', content: '猫🙂' });
  const half = JSON.stringify(second).slice(0, -5);
  await appendFile(join(f.directory, 'events.live.jsonl'), half);
  const partial = await f.read();
  assert.equal(partial.total, 1);
  assert.equal(partial.diagnostics.sourceBytesScanned, Buffer.byteLength(half));
  await appendFile(join(f.directory, 'events.live.jsonl'), `${JSON.stringify(second).slice(-5)}\n`);
  const complete = await f.read();
  assert.equal(complete.total, 2);
  assert.equal(complete.diagnostics.sourceBytesScanned, Buffer.byteLength(JSON.stringify(second)) + 1);
  const detail = await f.read({ kind: 'invocation', invocationId: 'second' });
  assert.deepEqual(detail.pages[0].events, [{ event: second }]);
});

test('truncation and atomic file replacement invalidate old rows and summaries', async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, 'events.live.jsonl');
  await writeFile(path, jsonl([event('old', 0, { type: 'text', content: 'long'.repeat(1000) })]));
  await f.read();
  await writeFile(path, jsonl([event('short', 0, { type: 'done' })]));
  assert.deepEqual(
    (await f.read()).invocations.map((item) => item.invocationId),
    ['short'],
  );
  await writeFile(`${path}.replacement`, jsonl([event('replacement', 0, { type: 'done' })]));
  await rename(`${path}.replacement`, path);
  assert.deepEqual(
    (await f.read()).invocations.map((item) => item.invocationId),
    ['replacement'],
  );
});

test('buffer overlay and file overlap retain repeated events with exact raw cursor numbering', async (t) => {
  const f = await fixture(t);
  const repeat = event('same', 0, { type: 'done' }, 42);
  const other = event('other', 1, { type: 'done' }, 42);
  await writeFile(join(f.directory, 'events.jsonl'), jsonl([repeat, repeat, other]));
  await writeFile(join(f.directory, 'events.live.jsonl'), jsonl([repeat, other]));
  f.input.buffered = [compactTranscriptEvent(other)];
  const result = await f.read({ kind: 'invocation', invocationId: 'same', cursor: 1, limit: 1 });
  assert.equal(result.pages[0].total, 2);
  assert.deepEqual(result.pages[0].events, [{ event: { ...repeat, eventNo: 1 } }]);
  const buffer = await f.read({ kind: 'invocation', invocationId: 'other' });
  assert.deepEqual(buffer.pages[0].events, [{ bufferIndex: 0, eventNo: 2 }]);
});

test('equal-time list order retains localeCompare semantics across the page boundary', async (t) => {
  const f = await fixture(t);
  const events = ['z', 'Z', 'a', 'A', '猫', 'é'].map((id, n) => event(id, n, { type: 'done' }, 42));
  await writeFile(join(f.directory, 'events.jsonl'), jsonl(events));
  const expected = projectInvocationTrajectories(events, session).sort((a, b) =>
    a.invocationId.localeCompare(b.invocationId),
  );
  assert.deepEqual((await f.read({ kind: 'list', limit: 2 })).invocations, expected.slice(0, 2));
});

test('concurrent cold index requests serialize publication without losing or mixing rows', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.directory, 'events.live.jsonl'),
    jsonl(Array.from({ length: 100 }, (_, n) => event(`inv-${n}`, n, { type: 'done' }))),
  );
  const [first, second] = await Promise.all([f.read(), f.read()]);
  assert.equal(first.total, 100);
  assert.deepEqual(second.invocations, first.invocations);
  assert.equal(second.total, 100);
});

test('a damaged disposable index does not make intact transcripts unreadable', async (t) => {
  const f = await fixture(t);
  const events = [event('source-truth', 0, { type: 'done' })];
  await writeFile(join(f.directory, 'events.jsonl'), jsonl(events));
  await writeFile(join(f.directory, 'invocations.v1.sqlite'), 'this is not a database');
  assert.deepEqual((await f.read()).invocations, projectInvocationTrajectories(events, session));
  assert.deepEqual((await f.read({ kind: 'invocation', invocationId: 'source-truth' })).pages[0].events, [
    { event: events[0] },
  ]);
});

test('read-only transcript directories remain readable without a persistent cache', async (t) => {
  const f = await fixture(t);
  const events = [event('read-only', 0, { type: 'done' })];
  await writeFile(join(f.directory, 'events.jsonl'), jsonl(events));
  await chmod(f.directory, 0o555);
  try {
    assert.deepEqual((await f.read()).invocations, projectInvocationTrajectories(events, session));
  } finally {
    await chmod(f.directory, 0o755);
  }
});
