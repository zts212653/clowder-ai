import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TranscriptEvent } from '../TranscriptReader.js';
import { InvocationSummaryAccumulator } from './InvocationSummaryAccumulator.js';
import type { InvocationIndexDiagnostics, SessionIndexInput } from './transcript-invocation-index-types.js';

/** Same counted-overlap rule as mergeTranscriptEventSources, materialized without full payloads. */
export function updateCanonicalInvocationIndex(
  db: Database.Database,
  input: SessionIndexInput,
  signatures: string[],
  diagnostics: InvocationIndexDiagnostics,
): void {
  const cacheKey = createHash('sha256')
    .update(JSON.stringify([input.session, input.includeLive, signatures, input.buffered.map((event) => event.hash)]))
    .digest('hex');
  const cached = db.prepare('SELECT key FROM cache WHERE id = 1').get() as { key: string } | undefined;
  if (cached?.key === cacheKey) {
    diagnostics.summaryCacheHits += 1;
    return;
  }
  db.exec(`CREATE TEMP TABLE buffer AS SELECT * FROM source_events WHERE 0`);
  const insertBuffer = db.prepare(`INSERT INTO buffer
    (source, seq, event_no, invocation_id, hash, byte_offset, byte_length, projection, files_touched)
    VALUES (2, ?, ?, ?, ?, 0, 0, ?, ?)`);
  for (let index = 0; index < input.buffered.length; index += 1) {
    const event = input.buffered[index];
    if (event)
      insertBuffer.run(
        index,
        index,
        event.projection.invocationId ?? null,
        event.hash,
        JSON.stringify(event.projection),
        JSON.stringify(event.filesTouched),
      );
  }
  db.exec(`
    CREATE TEMP TABLE active AS
    WITH counts AS (SELECT hash, COUNT(*) AS copies FROM buffer GROUP BY hash),
    ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY hash ORDER BY seq) AS occurrence
      FROM source_events WHERE source = 1 AND ${input.includeLive ? 1 : 0}),
    merged AS (
      SELECT source, seq, event_no, invocation_id, hash, byte_offset, byte_length, projection
      FROM ranked LEFT JOIN counts USING (hash) WHERE occurrence > COALESCE(copies, 0)
      UNION ALL SELECT source, seq, event_no, invocation_id, hash, byte_offset, byte_length, projection FROM buffer
    ) SELECT *, ROW_NUMBER() OVER (ORDER BY source, seq) - 1 AS active_no FROM merged;
    CREATE INDEX active_hash ON active(hash);
    DELETE FROM canonical;
  `);
  const activeCount = (db.prepare('SELECT COUNT(*) AS count FROM active').get() as { count: number }).count;
  if (activeCount === 0) {
    db.exec(`INSERT INTO canonical
      SELECT seq, source, seq, event_no, invocation_id, byte_offset, byte_length, projection
      FROM source_events WHERE source = 0 ORDER BY seq`);
  } else {
    db.exec(`
      INSERT INTO canonical
      WITH counts AS (SELECT hash, COUNT(*) AS copies FROM active GROUP BY hash),
      ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY hash ORDER BY seq) AS occurrence
        FROM source_events WHERE source = 0),
      merged AS (
        SELECT 0 AS priority, seq AS merge_no, source, seq, invocation_id, byte_offset, byte_length, projection
        FROM ranked LEFT JOIN counts USING (hash) WHERE occurrence > COALESCE(copies, 0)
        UNION ALL
        SELECT 1, active_no, source, seq, invocation_id, byte_offset, byte_length, projection FROM active
      ), numbered AS (SELECT *, ROW_NUMBER() OVER (ORDER BY priority, merge_no) - 1 AS event_no FROM merged)
      SELECT event_no, source, seq, event_no, invocation_id, byte_offset, byte_length, projection FROM numbered
      ORDER BY event_no;
    `);
  }
  const accumulator = new InvocationSummaryAccumulator(input.session);
  for (const row of db.prepare('SELECT projection FROM canonical ORDER BY logical_no').iterate() as Iterable<{
    projection: string;
  }>) {
    accumulator.add(JSON.parse(row.projection) as TranscriptEvent);
  }
  db.exec('DELETE FROM summaries');
  const insert = db.prepare('INSERT INTO summaries VALUES (?, ?, ?)');
  for (const summary of accumulator.values())
    insert.run(summary.invocationId, summary.startedAt, JSON.stringify(summary));
  db.prepare('INSERT OR REPLACE INTO cache VALUES (1, ?)').run(cacheKey);
}
