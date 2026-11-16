import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
import { TranscriptInvocationReader } from '../dist/domains/cats/services/session/transcript-index/TranscriptInvocationReader.js';
import { readTranscriptInvocationIndex } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-index-worker.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'transcript-source-selection-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = { id: 'session', threadId: 'thread', catId: 'cat', seq: 0, status: 'sealed' };
  const info = { sessionId: session.id, threadId: session.threadId, catId: session.catId, seq: session.seq };
  const reader = new TranscriptReader({ dataDir: root });
  return { root, session, info, reader, directory: reader.getSessionDir(session.threadId, session.catId, session.id) };
}

test('published sealed Raw preserves direct pagination without creating an invocation index', async (t) => {
  const f = await fixture(t);
  const writer = new TranscriptWriter({ dataDir: f.root });
  for (let n = 0; n < 2; n++)
    await writer.appendDurableEvent(f.info, { type: 'text', content: String(n).repeat(70 * 1024) }, 'wake');
  await writer.flush(f.info);
  const page = await new TranscriptInvocationReader(f.reader).readEvents(f.session, { limit: 200 });
  assert.equal(page.events.length, 2, 'published Raw keeps its existing row pagination, without a new byte watermark');
  assert.equal(page.total, 2);
  assert.equal(page.nextCursor, undefined);
  await assert.rejects(stat(join(f.directory, 'invocations.v1.sqlite')), { code: 'ENOENT' });
});

test('reading a session with no transcript returns empty without creating a directory or index', async (t) => {
  const f = await fixture(t);
  const page = await f.reader.readEvents(f.session.id, f.session.threadId, f.session.catId);
  assert.deepEqual(page.events, []);
  assert.equal(page.total, 0);
  assert.deepEqual(await f.reader.readAllEvents(f.session.id, f.session.threadId, f.session.catId), []);
  await assert.rejects(stat(f.directory), { code: 'ENOENT' });
});

test('the existing bulk reader honors its row limit on live-only history instead of applying the Raw byte bound', async (t) => {
  const f = await fixture(t);
  await mkdir(f.directory, { recursive: true });
  const lines = Array.from({ length: 2000 }, (_, n) =>
    JSON.stringify({
      v: 1,
      t: 1000 + n,
      ...f.info,
      invocationId: 'wake',
      eventNo: n,
      event: { type: 'text', content: `${n} ${'x'.repeat(500)}` },
    }),
  );
  await writeFile(join(f.directory, 'events.live.jsonl'), `${lines.join('\n')}\n`);
  const full = await f.reader.readEvents(f.session.id, f.session.threadId, f.session.catId, undefined, 10000);
  assert.equal(full.events.length, 2000, 'story export must not silently truncate at the interactive Raw byte bound');
  assert.equal(full.total, 2000);
  assert.equal(full.nextCursor, undefined);
  const tail = await f.reader.readEvents(f.session.id, f.session.threadId, f.session.catId, { eventNo: 1997 }, 2);
  assert.deepEqual(
    tail.events.map((event) => event.eventNo),
    [1997, 1998],
  );
  assert.deepEqual(tail.nextCursor, { eventNo: 1999 });
  const indexed = await readTranscriptInvocationIndex({
    sessions: [{ session: f.session, directory: f.directory, includeLive: true, buffered: [] }],
    query: { kind: 'transcriptEvents', cursor: 1997, limit: 2 },
  });
  assert.equal(indexed.pages[0].events.length, 2);
  assert.ok(
    indexed.diagnostics.hydratedBytes < 3 * Buffer.byteLength(lines[1997]),
    'a small bulk page hydrates only its requested rows',
  );
});
