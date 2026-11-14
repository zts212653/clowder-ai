import assert from 'node:assert/strict';
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import { TranscriptInvocationReader } from '../dist/domains/cats/services/session/transcript-index/TranscriptInvocationReader.js';
import { SessionChainStore } from '../dist/domains/cats/services/stores/ports/SessionChainStore.js';
import { sessionTranscriptRoutes } from '../dist/routes/session-transcript.js';

const WAKE = '2258e886-5256-41c0-91e9-450e29b8c2aa';
const OWNER = 'retirement-owner';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cat-cafe-retired-transcript-'));
  const sessions = new SessionChainStore();
  const session = await sessions.create({
    userId: OWNER,
    threadId: 'retirement-thread',
    catId: 'codex61-sol',
    sessionPurpose: 'watcher',
    chainKey: watcherSessionChainKey(OWNER, 'codex61-sol', 'retirement-thread'),
    cliSessionId: 'old-native',
  });
  const info = { sessionId: session.id, threadId: session.threadId, catId: session.catId, seq: session.seq };
  const reader = new TranscriptReader({ dataDir: root });
  const beforeRestart = new TranscriptWriter({ dataDir: root });
  await beforeRestart.appendDurableEvent(
    info,
    { type: 'text', content: 'unrelated earlier material'.repeat(4000) },
    'earlier',
  );
  // Same six diagnostic payloads and restart shape as boot85; native history is not simulated as proof.
  for (let n = 0; n < 5; n++)
    await beforeRestart.appendDurableEvent(
      info,
      { type: 'watcher_attempt_failure', reason: 'watcher_native_tool_surface_changed', origin: 'provider' },
      WAKE,
    );
  const writer = new TranscriptWriter({ dataDir: root });
  await writer.appendDurableEvent(
    info,
    { type: 'watcher_attempt_recovery', reason: 'uncommitted_turn_absent', sourceInvocationId: 'old-source' },
    WAKE,
  );
  const operation = {
    id: 'retirement',
    wakeInvocationId: WAKE,
    sourceInvocationId: 'old-source',
    sourceSequence: 55,
    oldSchemaHash: 'a'.repeat(64),
    nativeCliSessionId: 'old-native',
    phase: 'idle',
    probes: 1,
  };
  await sessions.compareAndSetWatcherState(
    session.id,
    0,
    {
      revision: 1,
      afterSequence: 54,
      consumedThrough: 'original',
      messageOffset: 1240,
      notes: 'unchanged notes',
      toolSchemaHash: operation.oldSchemaHash,
    },
    operation,
  );
  const app = Fastify({ logger: false });
  await app.register(sessionTranscriptRoutes, {
    invocationRecordStore: { get: async () => null },
    sessionChainStore: sessions,
    threadStore: { get: async () => ({ id: session.threadId, createdBy: OWNER }), list: async () => [] },
    transcriptReader: reader,
    transcriptWriter: writer,
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const get = (suffix, headers = {}) =>
    app.inject({
      url: `/api/sessions/${session.id}/${suffix}`,
      headers: { 'x-cat-cafe-user': OWNER, ...headers },
    });
  const retire = () =>
    sessions.rolloverWatcherSession({
      sessionId: session.id,
      expectedRevision: 1,
      expectedCliSessionId: 'old-native',
      retirementId: operation.id,
    });
  const directory = reader.getSessionDir(session.threadId, session.catId, session.id);
  return { root, sessions, session, info, reader, writer, get, retire, directory };
}

test('atomic watcher retirement preserves indexed and raw diagnostic reads before physical archive, including restart', async (t) => {
  const f = await fixture(t);
  const url = `invocations/${WAKE}?cursor=0&limit=40`;
  const before = await f.get(url);
  assert.equal(before.statusCode, 200);
  assert.equal(before.json().total, 6);
  const live = await readFile(join(f.directory, 'events.live.jsonl'), 'utf8');
  const successor = await f.retire();
  assert.ok(successor);
  assert.equal((await f.sessions.get(f.session.id)).status, 'sealed');
  assert.equal((await f.retire()).id, successor.id, 'the diagnostic read cannot create another successor');
  const after = await f.get(url);
  assert.equal(after.statusCode, 200, 'sealed metadata must not hide the durable, not-yet-archived invocation');
  assert.deepEqual(after.json().events, before.json().events, 'original event coordinates remain stable');
  assert.equal(after.json().total, 6);
  const all = new TranscriptInvocationReader(f.reader, f.writer);
  const old = await f.sessions.get(f.session.id);
  assert.equal((await all.list([old], 10)).total, 2);
  const bounded = await all.readEvents(old, { limit: 200 });
  assert.equal(bounded.events.length, 1, 'the Raw byte bound stays in force before a large first record');
  assert.equal(bounded.nextCursor.eventNo, 1);
  const page = await f.get(`invocations/${WAKE}?cursor=3&limit=2`);
  assert.deepEqual(
    page.json().events.map((e) => e.eventNo),
    [3, 4],
  );
  assert.equal(page.json().nextCursor.eventNo, 5);
  const raw = await f.get('events?cursor=1&limit=2');
  assert.equal(raw.json().total, 7);
  assert.deepEqual(
    raw.json().events.map((e) => e.eventNo),
    [1, 2],
  );
  const handoff = await f.get('events?view=handoff&limit=200');
  assert.equal(handoff.json().total, 7, 'handoff must read the same unarchived source');
  const restarted = new TranscriptInvocationReader(new TranscriptReader({ dataDir: f.root }));
  const recovered = (await restarted.readInvocation([old], WAKE)).get(old.id);
  assert.equal(recovered.total, 6, 'a new process needs no in-memory writer buffer');
  assert.deepEqual(recovered.events, before.json().events);
  assert.equal(await readFile(join(f.directory, 'events.live.jsonl'), 'utf8'), live);
  await assert.rejects(stat(join(f.directory, 'events.jsonl')), { code: 'ENOENT' });
  assert.equal(successor.watcherState.consumedThrough, 'original');
  assert.equal(successor.watcherState.messageOffset, 1240);
  assert.equal((await f.get(url, { 'x-cat-cafe-user': 'other-owner' })).statusCode, 403);
  assert.equal((await f.get(url, { 'x-cat-id': 'sonnet' })).statusCode, 403);
  assert.equal((await f.get('invocations/unknown')).statusCode, 404);
});

test('a published sealed archive remains authoritative over leftover live and buffered events, even when empty', async (t) => {
  const f = await fixture(t);
  await f.retire();
  await f.writer.flush(f.info);
  const canonicalPath = join(f.directory, 'events.jsonl');
  const canonical = await readFile(canonicalPath, 'utf8');
  await f.writer.appendDurableEvent(f.info, { type: 'text', content: 'late ghost' }, 'ghost');
  const ghostLine = JSON.stringify({
    v: 1,
    t: 1,
    ...f.info,
    invocationId: 'disk-ghost',
    eventNo: 7,
    event: { type: 'done' },
  });
  await appendFile(join(f.directory, 'events.live.jsonl'), `${ghostLine}\n`);
  assert.equal((await f.get(`invocations/${WAKE}?limit=40`)).json().total, 6);
  assert.equal((await f.get('invocations/ghost')).statusCode, 404);
  assert.equal((await f.get('events?limit=40')).json().total, 7);
  assert.equal(await readFile(canonicalPath, 'utf8'), canonical);
  await writeFile(canonicalPath, '');
  assert.equal((await f.get(`invocations/${WAKE}`)).statusCode, 404, 'an explicit empty archive is not missing');
  assert.equal((await f.get('events?view=handoff')).json().total, 0);
});

test('archive publication after the readiness check does not create a gap or duplicate the retired history', async (t) => {
  const f = await fixture(t);
  await f.retire();
  const hasTranscript = f.reader.hasTranscript.bind(f.reader);
  let published = false;
  f.reader.hasTranscript = async (...args) => {
    const ready = await hasTranscript(...args);
    if (!ready && !published) {
      published = true;
      await f.writer.flush(f.info);
    }
    return ready;
  };
  const response = await f.get(`invocations/${WAKE}?cursor=0&limit=40`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().total, 6);
  assert.deepEqual(
    response.json().events.map((e) => e.eventNo),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(published, true);
  await assert.rejects(stat(join(f.directory, 'events.live.jsonl')), { code: 'ENOENT' });
});
