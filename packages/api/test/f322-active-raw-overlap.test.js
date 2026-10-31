import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compactTranscriptEvent } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-compact-event.js';
import { readTranscriptInvocationIndex } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-index-worker.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'f322-overlap-occurrence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = { id: 'session', threadId: 'thread', catId: 'cat', seq: 0, status: 'active' };
  const event = (eventNo, payload) => ({
    v: 1,
    t: 42,
    threadId: session.threadId,
    catId: session.catId,
    sessionId: session.id,
    invocationId: 'target',
    eventNo,
    event: payload,
  });
  const anchor = event(0, { type: 'status', content: 'anchor' });
  const failed = event(1, { type: 'text', content: 'same native fragment' });
  const later = { ...failed, eventNo: 2 };
  const input = { session, directory, includeLive: true, buffered: [] };
  const write = (events) =>
    writeFile(join(directory, 'events.live.jsonl'), `${events.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const read = () =>
    readTranscriptInvocationIndex({ sessions: [input], query: { kind: 'events', cursor: 0, limit: 10 } });
  const materialize = (page, snapshot) =>
    page.events.map((item) =>
      'event' in item ? item.event : { ...snapshot[item.bufferIndex], eventNo: item.eventNo },
    );
  return { anchor, failed, later, input, write, read, materialize };
}

test('a failed buffered append and a later same-fingerprint disk occurrence both retain exact Raw coordinates', async (t) => {
  const f = await fixture(t);
  const frozen = [f.anchor, f.failed];
  f.input.buffered = frozen.map(compactTranscriptEvent);
  await f.write([f.anchor, f.later]);
  const page = (await f.read()).pages[0];
  assert.equal(page.total, 3);
  const events = f.materialize(page, frozen);
  assert.deepEqual(
    events.map((item) => item.eventNo),
    [0, 1, 2],
  );
  assert.deepEqual(
    events.map((item) => item.event.content),
    ['anchor', 'same native fragment', 'same native fragment'],
  );
});

test('true same-fingerprint live and buffer overlaps dedupe copies while retaining their two occurrences', async (t) => {
  const f = await fixture(t);
  const snapshot = [f.anchor, f.failed, f.later];
  f.input.buffered = snapshot.map(compactTranscriptEvent);
  await f.write(snapshot);
  const page = (await f.read()).pages[0];
  assert.equal(page.total, 3);
  assert.deepEqual(
    f.materialize(page, snapshot).map((item) => item.eventNo),
    [0, 1, 2],
  );
});

test('same-fingerprint buffer coordinate changes invalidate the derived overlap cache', async (t) => {
  const f = await fixture(t);
  await f.write([f.anchor, f.later]);
  f.input.buffered = [f.anchor, f.later].map(compactTranscriptEvent);
  assert.equal((await f.read()).pages[0].total, 2);
  const frozen = [f.anchor, f.failed];
  f.input.buffered = frozen.map(compactTranscriptEvent);
  const page = (await f.read()).pages[0];
  assert.equal(page.total, 3);
  assert.deepEqual(
    f.materialize(page, frozen).map((item) => item.eventNo),
    [0, 1, 2],
  );
});
