import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TranscriptEvent } from '../TranscriptReader.js';
import { InvocationSummaryAccumulator } from './InvocationSummaryAccumulator.js';
import { TRANSCRIPT_INVOCATION_PROJECTION_VERSION } from './transcript-invocation-index-schema.js';
import type { InvocationIndexDiagnostics, SessionIndexInput } from './transcript-invocation-index-types.js';
import { orderedTranscriptMergeSql } from './transcript-ordered-merge.js';

/** Counted overlaps retain source positions, materialized without full payloads. */
export function updateCanonicalInvocationIndex(
  db: Database.Database,
  input: SessionIndexInput,
  signatures: string[],
  diagnostics: InvocationIndexDiagnostics,
): void {
  const cacheKey = createHash('sha256')
    .update(
      JSON.stringify([
        TRANSCRIPT_INVOCATION_PROJECTION_VERSION,
        'ordered-overlap-v3-pointer-cache',
        input.session,
        input.includeLive,
        signatures,
        input.buffered.map((event) => [event.hash, event.projection.eventNo]),
      ]),
    )
    .digest('hex');
  const cached = db.prepare('SELECT key FROM cache WHERE id = 1').get() as { key: string } | undefined;
  if (cached?.key === cacheKey) {
    diagnostics.summaryCacheHits += 1;
    return;
  }
  db.exec(`CREATE TEMP TABLE buffer AS SELECT * FROM source_events WHERE 0;
    CREATE UNIQUE INDEX buffer_seq ON buffer(seq)`);
  const insertBuffer = db.prepare(`INSERT INTO buffer
    (source, seq, event_no, invocation_id, hash, byte_offset, byte_length, projection, files_touched)
    VALUES (2, ?, ?, ?, ?, 0, 0, ?, ?)`);
  let bufferedCount = 0;
  for (let index = 0; index < input.buffered.length; index += 1) {
    const event = input.buffered[index];
    if (event) {
      insertBuffer.run(
        index,
        event.projection.eventNo,
        event.projection.invocationId ?? null,
        event.hash,
        JSON.stringify(event.projection),
        JSON.stringify(event.filesTouched),
      );
      bufferedCount += 1;
    }
  }
  // Repeated identities can make a sparse plan reread an entire live run.
  // Count at most this many matches before choosing the original counted plan;
  // the probe can still scan nonmatching rows within a shared hash bucket.
  let rankOnlyMatchingPrimary = true;
  if (input.includeLive && bufferedCount > 0) {
    const sparseMatchLimit = bufferedCount * 2;
    const liveMatches = db
      .prepare(`SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM source_events WHERE source = 1
          AND (hash, event_no) IN (SELECT hash, event_no FROM buffer)
        LIMIT ?)`)
      .get(sparseMatchLimit + 1) as { count: number };
    rankOnlyMatchingPrimary = liveMatches.count <= sparseMatchLimit;
  }
  db.exec(`CREATE TEMP TABLE active AS ${orderedTranscriptMergeSql(
    `SELECT *, seq AS order_no FROM source_events WHERE source = 1 AND ${input.includeLive ? 1 : 0}`,
    'SELECT *, seq AS order_no FROM buffer',
    true,
    rankOnlyMatchingPrimary,
  )};
    CREATE INDEX active_hash ON active(hash);
    DELETE FROM canonical;
  `);
  const activeCount = (db.prepare('SELECT COUNT(*) AS count FROM active').get() as { count: number }).count;
  // Keep the old eight-column shape for rollback writers, but do not copy output
  // payloads into this derived pointer table. The cache key forces old rows to rebuild.
  if (activeCount === 0) {
    db.exec(`INSERT INTO canonical
      SELECT seq, source, seq, event_no, invocation_id, byte_offset, byte_length, ''
      FROM source_events WHERE source = 0 ORDER BY seq`);
  } else if (db.prepare('SELECT 1 FROM source_events WHERE source = 0 LIMIT 1').get() === undefined) {
    // Active already has contiguous merge_no order. An empty published source
    // cannot change it; retain the final merge's event-number rebasing directly.
    db.exec(`INSERT INTO canonical
      SELECT merge_no, source, seq, merge_no, invocation_id, byte_offset, byte_length, ''
      FROM active ORDER BY merge_no`);
  } else {
    db.exec(`INSERT INTO canonical
      SELECT merge_no, source, seq, merge_no, invocation_id, byte_offset, byte_length, ''
      FROM (${orderedTranscriptMergeSql(
        'SELECT *, seq AS order_no FROM source_events WHERE source = 0',
        'SELECT *, merge_no AS order_no FROM active',
      )}) merged ORDER BY merge_no`);
  }
  const accumulator = new InvocationSummaryAccumulator(input.session);
  // Source rows and buffer are still in the caller's update transaction, so each
  // pointer resolves the same full projection without another persisted copy.
  const projections = db.prepare(`SELECT c.event_no,
    CASE WHEN c.source = 2 THEN (SELECT projection FROM buffer WHERE seq = c.seq)
      ELSE (SELECT projection FROM source_events WHERE source = c.source AND seq = c.seq) END AS projection
    FROM canonical c ORDER BY c.logical_no`);
  for (const row of projections.iterate() as Iterable<{
    projection: string;
    event_no: number;
  }>) {
    accumulator.add({ ...(JSON.parse(row.projection) as TranscriptEvent), eventNo: row.event_no });
  }
  db.exec('DELETE FROM summaries');
  const insert = db.prepare('INSERT INTO summaries VALUES (?, ?, ?)');
  for (const summary of accumulator.values())
    insert.run(summary.invocationId, summary.startedAt, JSON.stringify(summary));
  db.prepare('INSERT OR REPLACE INTO cache VALUES (1, ?)').run(cacheKey);
}
