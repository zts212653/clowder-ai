import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import { TranscriptInvocationReader } from '../dist/domains/cats/services/session/transcript-index/TranscriptInvocationReader.js';
import { readTranscriptInvocationIndex } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-index-worker.js';

for (const hasNewSuffix of [false, true]) {
  test(`seal between source observations preserves restored history (new buffer suffix=${hasNewSuffix})`, async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'transcript-seal-race-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const session = { id: 'session', threadId: 'thread', catId: 'cat', seq: 0, status: 'sealing' };
    const info = { sessionId: session.id, threadId: session.threadId, catId: session.catId, seq: 0 };
    const reader = new TranscriptReader({ dataDir: root });
    const writer = new TranscriptWriter({ dataDir: root }); // restart: no restored events in its buffer
    const directory = reader.getSessionDir(session.threadId, session.catId, session.id);
    await fs.mkdir(directory, { recursive: true });
    const prefix = {
      v: 1,
      t: 42,
      ...info,
      invocationId: 'restored',
      eventNo: 0,
      event: { type: 'text', content: 'restored prefix' },
    };
    const other = { ...prefix, invocationId: 'other', eventNo: 2 };
    const canonical = join(directory, 'events.jsonl');
    const live = join(directory, 'events.live.jsonl');
    await fs.writeFile(live, `${[prefix, prefix, other].map((event) => JSON.stringify(event)).join('\n')}\n`);
    if (hasNewSuffix) writer.appendEvent(info, { type: 'done' }, 'restored');
    const snapshot = await writer.readBufferedSnapshot(info);
    const input = { session, directory, includeLive: true, buffered: snapshot.compact };

    const originalOpen = fs.open;
    let observations = 0;
    t.mock.method(fs, 'open', async (path, ...args) => {
      try {
        return await originalOpen(path, ...args);
      } finally {
        // Finish the real writer's seal after one source was observed but before the next is opened.
        if ((path === live || path === canonical) && ++observations === 1) await writer.flush(info);
      }
    });
    syncBuiltinESMExports();
    try {
      const list = await readTranscriptInvocationIndex({ sessions: [input], query: { kind: 'list', limit: 10 } });
      assert.ok(observations >= 2, 'both real source observations must pass through the barrier');
      assert.ok((await fs.stat(canonical)).size > 0);
      assert.equal(list.total, 2, 'seal cannot make restored invocations disappear');
      assert.equal(list.invocations.find((item) => item.invocationId === 'restored')?.eventCount, hasNewSuffix ? 3 : 2);
      const detail = await readTranscriptInvocationIndex({
        sessions: [input],
        query: { kind: 'invocation', invocationId: 'restored', cursor: 1, limit: 1 },
      });
      assert.equal(detail.pages[0].events[0].event.eventNo, 1);
      assert.equal(detail.pages[0].events[0].event.event.content, 'restored prefix');
      if (hasNewSuffix) assert.deepEqual(detail.pages[0].nextCursor, { eventNo: 3 });
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  });
}

test('a logically sealed session stays complete while its archive write is in progress', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'transcript-publish-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const session = { id: 'retired', threadId: 'thread', catId: 'cat', seq: 0, status: 'sealed' };
  const info = { sessionId: session.id, threadId: session.threadId, catId: session.catId, seq: 0 };
  const reader = new TranscriptReader({ dataDir: root });
  const writer = new TranscriptWriter({ dataDir: root });
  for (let n = 0; n < 3; n++) await writer.appendDurableEvent(info, { type: 'text', content: `record${n}` }, 'wake');
  const directory = reader.getSessionDir(session.threadId, session.catId, session.id);
  const canonical = join(directory, 'events.jsonl');
  const originalWrite = fs.writeFile;
  let observations = 0;
  t.mock.method(fs, 'writeFile', async (path, data, ...args) => {
    if (path === canonical || String(path).startsWith(join(directory, '.events.'))) {
      await originalWrite(path, `${String(data).split('\n')[0]}\n`, ...args);
      const during = (await new TranscriptInvocationReader(reader, writer).readInvocation([session], 'wake')).get(
        session.id,
      );
      observations++;
      assert.equal(during.total, 3, 'a partially written archive must not hide the remaining durable live records');
    }
    return originalWrite(path, data, ...args);
  });
  syncBuiltinESMExports();
  try {
    await writer.flush(info);
    assert.equal(observations, 1);
    const after = (await new TranscriptInvocationReader(reader, writer).readInvocation([session], 'wake')).get(
      session.id,
    );
    assert.equal(after.total, 3);
    assert.deepEqual(
      after.events.map((e) => e.eventNo),
      [0, 1, 2],
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('failed atomic publication preserves the previous archive and durable live recovery source', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'transcript-publish-failure-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const info = { sessionId: 'session', threadId: 'thread', catId: 'cat', seq: 0 };
  const writer = new TranscriptWriter({ dataDir: root });
  const reader = new TranscriptReader({ dataDir: root });
  const directory = reader.getSessionDir(info.threadId, info.catId, info.sessionId);
  const canonical = join(directory, 'events.jsonl');
  await writer.appendDurableEvent(info, { type: 'text', content: 'published original' }, 'original');
  await writer.flush(info);
  const original = await fs.readFile(canonical, 'utf8');
  await writer.appendDurableEvent(info, { type: 'text', content: 'durable recovery' }, 'recovery');
  t.mock.method(fs, 'rename', async () => {
    throw new Error('fixture publication unavailable');
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(writer.flush(info), /fixture publication unavailable/);
    assert.equal(await fs.readFile(canonical, 'utf8'), original);
    assert.match(await fs.readFile(join(directory, 'events.live.jsonl'), 'utf8'), /durable recovery/);
    assert.equal((await writer.readBufferedSnapshot(info)).events.length, 1);
    assert.equal(
      (await fs.readdir(directory)).some((name) => name.startsWith('.events.')),
      false,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('bulk recovery does not return empty when publication removes live during the source preflight', async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'transcript-source-preflight-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const info = { sessionId: 'session', threadId: 'thread', catId: 'cat', seq: 0 };
  const writer = new TranscriptWriter({ dataDir: root });
  const reader = new TranscriptReader({ dataDir: root });
  for (let n = 0; n < 3; n++) await writer.appendDurableEvent(info, { type: 'text', content: `record${n}` }, 'wake');
  const live = join(reader.getSessionDir(info.threadId, info.catId, info.sessionId), 'events.live.jsonl');
  const originalStat = fs.stat;
  let published = false;
  t.mock.method(fs, 'stat', async (path, ...args) => {
    if (path === live && !published) {
      published = true;
      await writer.flush(info);
    }
    return originalStat(path, ...args);
  });
  syncBuiltinESMExports();
  try {
    const events = await reader.readAllEvents(info.sessionId, info.threadId, info.catId);
    assert.equal(published, true);
    assert.deepEqual(
      events.map((event) => event.eventNo),
      [0, 1, 2],
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
