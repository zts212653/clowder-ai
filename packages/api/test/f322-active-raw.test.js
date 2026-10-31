import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import { compactTranscriptEvent } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-compact-event.js';
import { readTranscriptInvocationIndex } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-index-worker.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { sessionTranscriptRoutes } from '../dist/routes/session-transcript.js';

const output = (content) => ({
  type: 'text',
  content,
  outputMessage: {
    provider: 'codex',
    runtimeSessionId: 'native-session',
    turnId: 'native-turn',
    nativeId: 'native-first-message',
    channel: 'commentary',
    complete: true,
  },
});

async function fixture(t, withWriter = true) {
  const root = await mkdtemp(join(tmpdir(), 'f322-active-raw-'));
  const sessions = new SessionChainStore();
  const session = await sessions.create({ threadId: 'thread-raw', catId: 'cat-raw', userId: 'owner-raw' });
  const reader = new TranscriptReader({ dataDir: root });
  const writer = new TranscriptWriter({ dataDir: root });
  const directory = reader.getSessionDir(session.threadId, session.catId, session.id);
  await mkdir(directory, { recursive: true });
  const app = Fastify({ logger: false });
  await app.register(sessionTranscriptRoutes, {
    invocationRecordStore: { get: async () => null },
    sessionChainStore: sessions,
    threadStore: { get: async () => ({ id: session.threadId, createdBy: 'owner-raw' }), list: async () => [] },
    transcriptReader: reader,
    ...(withWriter ? { transcriptWriter: writer } : {}),
  });
  t.after(async () => {
    await writer.drainPendingWrites();
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const info = { sessionId: session.id, threadId: session.threadId, catId: session.catId, seq: session.seq };
  const get = (url, userId = 'owner-raw') => app.inject({ url, headers: { 'x-cat-cafe-user': userId } });
  const event = (n, payload) => ({
    v: 1,
    t: 1000 + n,
    threadId: session.threadId,
    catId: session.catId,
    sessionId: session.id,
    invocationId: 'target',
    eventNo: n,
    event: payload,
  });
  return { root, sessions, session, directory, writer, reader, info, get, event, app };
}

test('an active unsealed session opens the exact first-output Raw source advertised by its list and detail', async (t) => {
  const f = await fixture(t);
  await f.writer.appendDurableEvent(f.info, { type: 'status', content: 'start' }, 'target');
  await f.writer.appendDurableEvent(f.info, output('第一条原生输出。'), 'target');
  await f.writer.appendDurableEvent(f.info, { type: 'done' }, 'target');
  const list = await f.get('/api/threads/thread-raw/invocations');
  assert.equal(list.statusCode, 200, list.body);
  const evidence = list.json().invocations[0].firstAssistantOutputEvidence;
  assert.equal(evidence.status, 'available');
  assert.equal(evidence.source.firstEventNo, 1);
  const detail = await f.get(`/api/sessions/${f.session.id}/invocations/target?cursor=1&limit=1`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().events[0].event.outputMessage.nativeId, evidence.identity.nativeId);
  const raw = await f.get(`/api/sessions/${f.session.id}/events?view=raw&cursor=1&limit=1`);
  assert.equal(raw.statusCode, 200, raw.body);
  assert.deepEqual(raw.json().events, detail.json().events);
  assert.equal(raw.json().total, 3);
  assert.deepEqual(raw.json().nextCursor, { eventNo: 2 });
});

test('active Raw charOffset reads the same source without sealing and keeps existing access denial', async (t) => {
  const f = await fixture(t);
  const payload = output('猫🙂'.repeat(5000));
  await f.writer.appendDurableEvent(f.info, payload, 'target');
  const url = `/api/sessions/${f.session.id}/events?view=raw&cursor=0&limit=1&charOffset=8000`;
  const denied = await f.get(url, 'different-owner');
  assert.equal(denied.statusCode, 403, denied.body);
  const response = await f.get(url);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().eventNo, 0);
  assert.equal(response.json().eventSlice, JSON.stringify(payload).slice(8000, 16000));
});

test('disk appends after a buffer snapshot preserve first-output coordinates and native source order', async (t) => {
  const f = await fixture(t);
  const events = [f.event(0, { type: 'status' }), f.event(1, output('第一条原生输出。'))];
  const input = {
    session: f.session,
    directory: f.directory,
    includeLive: true,
    buffered: events.map(compactTranscriptEvent),
  };
  const read = (query) => readTranscriptInvocationIndex({ sessions: [input], query });
  const write = (items) =>
    writeFile(join(f.directory, 'events.live.jsonl'), `${items.map((item) => JSON.stringify(item)).join('\n')}\n`);
  await write(events);
  const before = await read({ kind: 'list', limit: 1 });
  assert.equal(before.invocations[0].firstAssistantOutputEvidence.source.firstEventNo, 1);
  // The read-side snapshot is frozen while the writer legitimately appends a later event.
  await write([...events, f.event(2, { type: 'done' })]);
  const after = await read({ kind: 'list', limit: 1 });
  assert.deepEqual(
    after.invocations[0].firstAssistantOutputEvidence,
    before.invocations[0].firstAssistantOutputEvidence,
  );
  const page = await read({ kind: 'invocation', invocationId: 'target', cursor: 0, limit: 10 });
  const source = page.pages[0].events.map((item) =>
    'event' in item ? item.event : { ...events[item.bufferIndex], eventNo: item.eventNo },
  );
  assert.deepEqual(
    source.map((item) => item.event.type),
    ['status', 'text', 'done'],
  );
  assert.deepEqual(
    source.map((item) => item.eventNo),
    [0, 1, 2],
  );
});

test('a fresh reader without the old process buffer can reopen an unsealed exact source', async (t) => {
  const f = await fixture(t, false);
  await f.writer.appendDurableEvent(f.info, output('重启前的原生输出。'), 'target');
  const list = await f.get('/api/threads/thread-raw/invocations');
  assert.equal(list.statusCode, 200, list.body);
  const evidence = list.json().invocations[0].firstAssistantOutputEvidence;
  assert.equal(evidence.identity.nativeId, 'native-first-message');
  const raw = await f.get(`/api/sessions/${f.session.id}/events?view=raw&cursor=0&limit=1`);
  assert.equal(raw.statusCode, 200, raw.body);
  assert.equal(raw.json().events[0].event.content, evidence.content);
  assert.equal(raw.json().events[0].event.outputMessage.channel, evidence.channel);
});

test('real live-to-sealed publication preserves the source coordinate and original Raw payload', async (t) => {
  const f = await fixture(t);
  await f.writer.appendDurableEvent(f.info, { type: 'status' }, 'target');
  await f.writer.appendDurableEvent(f.info, output('封存前后的同一输出。'), 'target');
  await f.writer.appendDurableEvent(f.info, { type: 'done' }, 'target');
  const url = `/api/sessions/${f.session.id}/events?view=raw&cursor=1&limit=1`;
  const before = await f.get(url);
  assert.equal(before.statusCode, 200, before.body);
  await f.writer.flush(f.info, { createdAt: 1000, sealedAt: 2000 });
  await f.sessions.update(f.session.id, { status: 'sealed', sealedAt: 2000 });
  const after = await f.get(url);
  assert.equal(after.statusCode, 200, after.body);
  assert.deepEqual(after.json(), before.json());
  const list = await f.get('/api/threads/thread-raw/invocations');
  assert.equal(list.json().invocations[0].firstAssistantOutputEvidence.source.firstEventNo, 1);
});

test('the buffered source retains a missing disk event between shared positions', async (t) => {
  const f = await fixture(t);
  const events = [
    f.event(0, { type: 'status' }),
    f.event(1, output('仍留在内存的原生输出。')),
    f.event(2, { type: 'done' }),
  ];
  await writeFile(
    join(f.directory, 'events.live.jsonl'),
    `${[events[0], events[2]].map((item) => JSON.stringify(item)).join('\n')}\n`,
  );
  const result = await readTranscriptInvocationIndex({
    sessions: [
      { session: f.session, directory: f.directory, includeLive: true, buffered: events.map(compactTranscriptEvent) },
    ],
    query: { kind: 'events', cursor: 0, limit: 10 },
  });
  assert.deepEqual(
    result.pages[0].events.map((item) => item.eventNo ?? item.event.eventNo),
    [0, 1, 2],
  );
  const text = result.pages[0].events[1];
  assert.equal(text.bufferIndex, 1);
});

test('Raw access is denied before a live session can produce any index', async (t) => {
  const f = await fixture(t);
  await f.writer.appendDurableEvent(f.info, output('不得泄漏的原生输出。'), 'target');
  const url = `/api/sessions/${f.session.id}/events?view=raw&cursor=0&limit=1`;
  assert.equal((await f.app.inject({ url })).statusCode, 401);
  assert.equal((await f.get(url, 'different-owner')).statusCode, 403);
  const deniedCat = await f.app.inject({ url, headers: { 'x-cat-cafe-user': 'owner-raw', 'x-cat-id': 'another-cat' } });
  assert.equal(deniedCat.statusCode, 403);
  await assert.rejects(stat(join(f.directory, 'invocations.v1.sqlite')), { code: 'ENOENT' });
});

test('a warm exact read of a 300MiB active source hydrates only the requested record', async (t) => {
  const f = await fixture(t, false);
  const path = join(f.directory, 'events.live.jsonl');
  const file = await open(path, 'w');
  const prefixCount = 10000;
  try {
    for (let n = 0; n < prefixCount; n++) {
      await file.write(`${JSON.stringify(f.event(n, { type: 'tool_result', content: 'x'.repeat(32768) }))}\n`);
    }
    await file.write(`${JSON.stringify(f.event(prefixCount, output('大文件中的精确原生输出。')))}\n`);
  } finally {
    await file.close();
  }
  assert.ok((await stat(path)).size > 300 * 1024 * 1024);
  const list = await f.get('/api/threads/thread-raw/invocations');
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().invocations[0].firstAssistantOutputEvidence.source.firstEventNo, prefixCount);
  const warm = await readTranscriptInvocationIndex({
    sessions: [{ session: f.session, directory: f.directory, includeLive: true, buffered: [] }],
    query: { kind: 'events', cursor: prefixCount, limit: 1 },
  });
  assert.equal(warm.diagnostics.sourceBytesScanned, 0);
  assert.ok(warm.diagnostics.hydratedBytes < 1024);
  const raw = await f.get(`/api/sessions/${f.session.id}/events?view=raw&cursor=${prefixCount}&limit=1`);
  assert.equal(raw.statusCode, 200, raw.body);
  assert.equal(raw.json().events[0].eventNo, prefixCount);
  assert.equal(raw.json().events[0].event.outputMessage.nativeId, 'native-first-message');
});
