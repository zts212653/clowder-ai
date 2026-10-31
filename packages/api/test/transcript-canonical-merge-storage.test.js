import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { updateCanonicalInvocationIndex } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-canonical-index.js';
import { compactTranscriptEvent } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-compact-event.js';
import { TRANSCRIPT_INVOCATION_INDEX_SCHEMA } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-index-schema.js';

test('wide output evidence survives overlap without retaining its payload again in temporary merge tables', () => {
  const db = new Database(':memory:');
  try {
    db.exec(TRANSCRIPT_INVOCATION_INDEX_SCHEMA);
    const insert = db.prepare('INSERT INTO source_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const session = {
      id: 'private-session',
      threadId: 'private-thread',
      catId: 'private-cat',
      seq: 1,
      status: 'active',
    };
    const expected = [];
    db.transaction(() => {
      for (let n = 0; n < 1000; n += 1) {
        const compact = compactTranscriptEvent({
          v: 1,
          t: n,
          ...{ threadId: session.threadId, catId: session.catId, sessionId: session.id },
          invocationId: `inv-${n}`,
          eventNo: n,
          event: {
            type: 'text',
            content: `${n}:`.padEnd(4096, 'x'),
            outputMessage: {
              provider: 'private',
              runtimeSessionId: 'private-runtime',
              turnId: `turn-${n}`,
              nativeId: `native-${n}`,
              channel: 'final',
              complete: true,
            },
          },
        });
        const projection = JSON.stringify(compact.projection);
        expected.push({ logical_no: n, source: 1, seq: n, event_no: n, projection });
        for (const source of [0, 1])
          insert.run(source, n, n, `inv-${n}`, compact.hash, n * 5000, 5000, projection, '[]');
      }
    })();
    updateCanonicalInvocationIndex(
      db,
      { session, directory: 'unused', buffered: [], includeLive: true },
      ['disk', 'live'],
      {
        sourceBytesScanned: 0,
        hydratedBytes: 0,
        summaryCacheHits: 0,
      },
    );
    assert.deepEqual(
      db
        .prepare(`SELECT c.logical_no, c.source, c.seq, c.event_no, s.projection
        FROM canonical c JOIN source_events s ON s.source = c.source AND s.seq = c.seq
        ORDER BY c.logical_no`)
        .all(),
      expected,
    );
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM summaries').get().count, 1000);
    const tempBytes = db.pragma('temp.page_count', { simple: true }) * db.pragma('temp.page_size', { simple: true });
    assert.ok(tempBytes < 1024 * 1024, `merge retained ${tempBytes} temporary bytes for 1000 compact pointers`);
  } finally {
    db.close();
  }
});
