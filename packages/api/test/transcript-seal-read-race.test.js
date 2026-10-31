import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TranscriptReader } from '../dist/domains/cats/services/session/TranscriptReader.js';
import { TranscriptWriter } from '../dist/domains/cats/services/session/TranscriptWriter.js';
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
