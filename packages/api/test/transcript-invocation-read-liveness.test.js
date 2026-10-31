import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import { TranscriptInvocationReader } from '../dist/domains/cats/services/session/transcript-index/TranscriptInvocationReader.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { sessionTranscriptRoutes } from '../dist/routes/session-transcript.js';
import { withTranscriptReadSignal } from '../dist/routes/transcript-read-cancellation.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-invocation-index-'));
  const sessions = new SessionChainStore();
  const session = await sessions.create({ threadId: 'thread-index', catId: 'cat-index', userId: 'owner-index' });
  const reader = new TranscriptReader({ dataDir: root });
  const writer = new TranscriptWriter({ dataDir: root });
  const dir = reader.getSessionDir(session.threadId, session.catId, session.id);
  await mkdir(dir, { recursive: true });
  const app = Fastify({ logger: false });
  await app.register(sessionTranscriptRoutes, {
    invocationRecordStore: { get: async () => null },
    sessionChainStore: sessions,
    threadStore: { get: async () => ({ id: session.threadId, createdBy: 'owner-index' }), list: async () => [] },
    transcriptReader: reader,
    transcriptWriter: writer,
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const event = (invocationId, eventNo, payload, t = 1000 + eventNo) => ({
    v: 1,
    t,
    threadId: session.threadId,
    catId: session.catId,
    sessionId: session.id,
    invocationId,
    eventNo,
    event: payload,
  });
  const write = (file, events) =>
    writeFile(join(dir, file), `${events.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const get = (url) => app.inject({ url, headers: { 'x-cat-cafe-user': 'owner-index' } });
  return { root, dir, app, session, sessions, reader, writer, event, write, get };
}

test('invocation list and paged detail no longer ask either source for an entire session payload', async (t) => {
  const f = await fixture(t);
  const events = [
    f.event('earlier', 0, { type: 'tool_result', content: 'x'.repeat(2_000_000) }),
    f.event('target', 1, { type: 'text', content: 'hello' }),
    f.event('target', 2, { type: 'done' }),
  ];
  await f.write('events.jsonl', events);
  await f.write('events.live.jsonl', events.slice(1));
  f.reader.readAllEvents = async () => {
    throw new Error('unbounded sealed transcript read');
  };
  f.writer.readActiveEvents = async () => {
    throw new Error('unbounded live transcript read');
  };
  const list = await f.get('/api/threads/thread-index/invocations?limit=1');
  assert.equal(list.statusCode, 200, list.body);
  assert.equal(list.json().total, 2);
  assert.equal(list.json().invocations[0].invocationId, 'target');
  assert.equal(list.json().invocations[0].eventCount, 2);
  const detail = await f.get(`/api/sessions/${f.session.id}/invocations/target?cursor=1&limit=1`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().total, 2);
  assert.equal(detail.json().events[0].eventNo, 1);
  assert.equal(detail.json().events[0].event.content, 'hello');
  assert.deepEqual(detail.json().nextCursor, { eventNo: 2 });
});

test('indexed merge preserves duplicate multiplicity and invocation identity through a restart and seal', async (t) => {
  const f = await fixture(t);
  const first = f.event('before', 0, { type: 'done' }, 42);
  const second = f.event('after', 1, { type: 'done' }, 42);
  await f.write('events.jsonl', [first, first, second]);
  await f.write('events.live.jsonl', [first, second]);
  const list = await f.get('/api/threads/thread-index/invocations');
  assert.equal(list.statusCode, 200, list.body);
  assert.deepEqual(
    new Map(list.json().invocations.map((item) => [item.invocationId, item.eventCount])),
    new Map([
      ['before', 2],
      ['after', 1],
    ]),
  );
  const detail = await f.get(`/api/sessions/${f.session.id}/invocations/before?limit=10`);
  assert.equal(detail.statusCode, 200, detail.body);
  assert.deepEqual(
    detail.json().events.map((item) => item.eventNo),
    [0, 1],
  );
  await f.sessions.update(f.session.id, { status: 'sealed', sealedAt: 100 });
  const sealed = await f.get('/api/threads/thread-index/invocations');
  assert.equal(sealed.statusCode, 200, sealed.body);
  assert.equal(sealed.json().invocations.find((item) => item.invocationId === 'before').eventCount, 2);
});

test('invalid invocation pagination is rejected before reading or indexing any transcript', async (t) => {
  const f = await fixture(t);
  f.reader.readAllEvents = async () => {
    throw new Error('must validate before expensive read');
  };
  f.writer.readActiveEvents = async () => {
    throw new Error('must validate before expensive read');
  };
  const response = await f.get(`/api/sessions/${f.session.id}/invocations/target?limit=-1`);
  assert.equal(response.statusCode, 400, response.body);
});

test('file-touch projection uses the same compact index instead of rereading the live payload', async (t) => {
  const f = await fixture(t);
  f.writer.appendEvent(
    { sessionId: f.session.id, threadId: f.session.threadId, catId: f.session.catId, seq: 0 },
    {
      type: 'tool_use',
      toolName: 'Write',
      toolInput: { file_path: '/tmp/owned-result.txt', content: 'x'.repeat(100_000) },
    },
    'target',
  );
  await f.writer.drainPendingWrites();
  f.writer.readEventsFromLiveFile = async () => {
    throw new Error('unbounded file-touch read');
  };
  assert.deepEqual(
    await f.writer.getFilesTouched(f.session.id, { threadId: f.session.threadId, catId: f.session.catId }),
    [{ path: '/tmp/owned-result.txt', ops: ['create'] }],
  );
});

test('aborting a reader waiting on an index lock releases its worker and allows a subsequent read', async (t) => {
  const f = await fixture(t);
  await f.write('events.jsonl', [f.event('after-cancel', 0, { type: 'done' })]);
  const db = new Database(join(f.dir, 'invocations.v1.sqlite'));
  const reader = new TranscriptInvocationReader(f.reader, f.writer);
  const controller = new AbortController();
  db.exec('BEGIN IMMEDIATE');
  const timer = setTimeout(() => controller.abort(new Error('client left')), 80);
  try {
    await assert.rejects(reader.list([f.session], 10, controller.signal), /client left/);
  } finally {
    clearTimeout(timer);
    db.exec('ROLLBACK');
    db.close();
  }
  assert.equal((await reader.list([f.session], 10)).total, 1);
});

test('disconnect during authorization cannot start an uncancellable transcript read afterwards', async () => {
  const request = { raw: Object.assign(new EventEmitter(), { aborted: false }) };
  const reply = { raw: Object.assign(new EventEmitter(), { destroyed: true, writableEnded: false }) };
  await assert.rejects(
    withTranscriptReadSignal(request, reply, async (signal) => signal.throwIfAborted()),
    /disconnected/,
  );
  assert.equal(request.raw.listenerCount('aborted'), 0);
  assert.equal(reply.raw.listenerCount('close'), 0);
});
