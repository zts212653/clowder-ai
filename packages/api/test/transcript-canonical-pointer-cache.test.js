import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { updateCanonicalInvocationIndex } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-canonical-index.js';
import { compactTranscriptEvent } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-compact-event.js';
import {
  TRANSCRIPT_INVOCATION_INDEX_SCHEMA,
  TRANSCRIPT_INVOCATION_PROJECTION_VERSION,
} from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-index-schema.js';
import { readTranscriptInvocationIndex } from '../dist/domains/cats/services/session/transcript-index/transcript-invocation-index-worker.js';

const session = { id: 'session', threadId: 'thread', catId: 'codex61-sol', seq: 0, status: 'active' };
const event = (n) => ({
  v: 1,
  t: 1000 + n,
  threadId: session.threadId,
  catId: session.catId,
  sessionId: session.id,
  invocationId: 'inv',
  eventNo: n,
  event: {
    type: 'text',
    content: `${n}:`.padEnd(4096, 'x'),
    outputMessage: {
      provider: 'private',
      runtimeSessionId: 'private-runtime',
      turnId: 'private-turn',
      nativeId: `output-${n}`,
      channel: 'final',
      complete: true,
    },
  },
});

for (const sources of [[0], [1], [0, 1]]) {
  test(`canonical cache stores compact pointers with sources ${sources.join('+')} and preserves full output`, () => {
    const db = new Database(':memory:');
    try {
      db.exec(TRANSCRIPT_INVOCATION_INDEX_SCHEMA);
      const insert = db.prepare('INSERT INTO source_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      db.transaction(() => {
        for (let n = 0; n < 1000; n += 1) {
          const compact = compactTranscriptEvent(event(n));
          for (const source of sources)
            insert.run(source, n, n, 'inv', compact.hash, n * 5000, 5000, JSON.stringify(compact.projection), '[]');
        }
      })();
      updateCanonicalInvocationIndex(
        db,
        { session, directory: 'unused', buffered: [], includeLive: true },
        ['disk', 'live'],
        { sourceBytesScanned: 0, hydratedBytes: 0, summaryCacheHits: 0 },
      );
      const rows = db.prepare('SELECT logical_no, source, seq, event_no FROM canonical ORDER BY logical_no').all();
      assert.deepEqual(
        rows,
        Array.from({ length: 1000 }, (_, n) => ({ logical_no: n, source: sources.at(-1), seq: n, event_no: n })),
      );
      const summary = JSON.parse(
        db.prepare('SELECT projection FROM summaries WHERE invocation_id = ?').get('inv').projection,
      );
      assert.equal(summary.eventCount, 1000);
      assert.equal(summary.firstAssistantOutputEvidence.content, event(0).event.content);
      const full = JSON.parse(
        db
          .prepare(`SELECT s.projection FROM canonical c JOIN source_events s
        ON s.source = c.source AND s.seq = c.seq WHERE c.logical_no = 999`)
          .get().projection,
      );
      assert.equal(full.event.assistantOutputFragment.content, event(999).event.content);
      const bytes = db.prepare("SELECT SUM(pgsize) AS bytes FROM dbstat WHERE name = 'canonical'").get().bytes;
      assert.ok(bytes < 256 * 1024, `canonical cache duplicated output payload into ${bytes} bytes`);
    } finally {
      db.close();
    }
  });
}

test('legacy wide cache is rekeyed without rescanning source checkpoints or breaking the prior SQL shape', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'canonical-pointer-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = `${JSON.stringify(event(0))}\n${JSON.stringify(event(1))}\n`;
  await writeFile(join(directory, 'events.live.jsonl'), source);
  const input = { session, directory, buffered: [], includeLive: true };
  const read = () => readTranscriptInvocationIndex({ sessions: [input], query: { kind: 'list', limit: 20 } });
  const original = await read();
  const cache = join(directory, 'invocations.v1.sqlite');
  let db = new Database(cache);
  const checkpoints = db.prepare('SELECT * FROM sources ORDER BY source').all();
  // A previous writer can still persist its eight-column rows after the new writer ran.
  db.exec(`UPDATE canonical AS c SET projection =
    (SELECT projection FROM source_events WHERE source = c.source AND seq = c.seq)`);
  const signatures = [0, 1].map((source) => checkpoints.find((row) => row.source === source)?.signature ?? 'missing');
  const oldKey = createHash('sha256')
    .update(
      JSON.stringify([TRANSCRIPT_INVOCATION_PROJECTION_VERSION, 'ordered-overlap-v2', session, true, signatures, []]),
    )
    .digest('hex');
  db.prepare('UPDATE cache SET key = ?').run(oldKey);
  db.close();
  const upgraded = await read();
  assert.deepEqual(upgraded.invocations, original.invocations);
  assert.equal(upgraded.diagnostics.sourceBytesScanned, 0);
  assert.equal(upgraded.diagnostics.summaryCacheHits, 0);
  db = new Database(cache);
  assert.deepEqual(db.prepare('SELECT * FROM sources ORDER BY source').all(), checkpoints);
  assert.equal(
    db.pragma('table_info(canonical)').some((column) => column.name === 'projection'),
    true,
  );
  assert.equal(db.prepare('SELECT SUM(length(projection)) AS bytes FROM canonical').get().bytes, 0);
  db.close();
  assert.equal((await read()).diagnostics.summaryCacheHits, 1);
  assert.equal(await readFile(join(directory, 'events.live.jsonl'), 'utf8'), source);
});
