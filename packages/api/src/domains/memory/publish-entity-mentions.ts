import { channel } from 'node:diagnostics_channel';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import {
  assertCurrentMentionGeneration,
  EntityMentionProjectionConflictError,
} from './entity-mention-generation-fence.js';
import { runMemoryProjection } from './MemoryProcess.js';
import type { MentionProjectionInput, MentionProjectionResult } from './memory-process-protocol.js';
import { type ProjectionCheckpoints, withProjectionCheckpoints } from './projection-checkpoints.js';

const columns = 'entity_id, doc_anchor, passage_id, surface, surface_norm, source, provenance_json, created_at';
const BATCH_SIZE = 256;

/** Caller holds the evidence writer queue. Staging yields between bounded writes;
 * a single short transaction publishes source mutation, revision and heads. */
export async function publishEntityMentions(
  db: Database.Database,
  dbPath: string,
  input: MentionProjectionInput,
  applyMutation: () => void,
): Promise<void> {
  if (input.operation === 'mentions' && !db.prepare('SELECT 1 FROM entity_registry LIMIT 1').get()) {
    db.prepare('DELETE FROM entity_mention_pending_docs').run();
    return;
  }
  return withProjectionCheckpoints(db, dbPath, (checkpoints) =>
    publishWithCheckpoints(db, dbPath, input, applyMutation, checkpoints),
  );
}

async function publishWithCheckpoints(
  db: Database.Database,
  dbPath: string,
  input: MentionProjectionInput,
  applyMutation: () => void,
  checkpoints: ProjectionCheckpoints,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'cat-cafe-mentions-'));
  const stagingPath = join(directory, 'projection.sqlite');
  let attached = false;
  let generation: number | undefined;
  let published = false;
  try {
    const projection = await runMemoryProjection<MentionProjectionResult>({
      kind: 'project-mentions',
      dbPath,
      stagingPath,
      ...input,
    });
    if (!projection.changed) return;
    const currentRevision = () =>
      (db.prepare('SELECT revision FROM memory_source_revision WHERE id=1').get() as { revision: number }).revision;
    const assertCurrent = () => {
      if (currentRevision() !== projection.sourceRevision)
        throw new EntityMentionProjectionConflictError(
          'Entity mention source revision changed during projection; retry against current truth',
        );
    };
    assertCurrent();
    generation = Number(
      db
        .prepare("INSERT INTO entity_mention_generations (owner_pid, phase, scopes_json) VALUES (?, 'staging', ?)")
        .run(process.pid, JSON.stringify(projection)).lastInsertRowid,
    );
    db.prepare('ATTACH DATABASE ? AS mention_stage').run(stagingPath);
    attached = true;
    const page = db.prepare(
      'SELECT rowid AS id FROM mention_stage.entity_mentions WHERE rowid > ? ORDER BY rowid LIMIT ?',
    );
    const stage = db.prepare(
      `INSERT INTO entity_mention_rows (generation, ${columns}) SELECT ?, ${columns} FROM mention_stage.entity_mentions WHERE rowid > ? AND rowid <= ?`,
    );
    let cursor = 0;
    for (;;) {
      await yieldToIo();
      assertCurrent();
      const ids = page.all(cursor, BATCH_SIZE) as { id: number }[];
      if (!ids.length) break;
      const end = ids[ids.length - 1]!.id;
      db.transaction(() => stage.run(generation, cursor, end)).immediate();
      cursor = end;
      channel('cat-cafe.entity-mention-projection').publish({ phase: 'staging', generation, rows: cursor });
      await checkpoints.afterBatch();
    }
    // No scan, row copy or corpus-sized delete in the publication transaction.
    const publicationStart = performance.now();
    db.transaction(() => {
      assertCurrent();
      assertCurrentMentionGeneration(db, projection, generation!);
      applyMutation();
      const entityHead = db.prepare(
        'INSERT INTO entity_mention_entity_heads VALUES (?, ?) ON CONFLICT(entity_id) DO UPDATE SET generation=excluded.generation WHERE excluded.generation > generation',
      );
      const docHead = db.prepare(
        'INSERT INTO entity_mention_doc_heads VALUES (?, ?) ON CONFLICT(doc_anchor) DO UPDATE SET generation=excluded.generation WHERE excluded.generation > generation',
      );
      for (const id of projection.entityIds ?? []) entityHead.run(id, generation);
      for (const anchor of projection.docAnchors ?? []) docHead.run(anchor, generation);
      if (input.operation === 'mentions') {
        if (input.docAnchors?.length) {
          const clearPending = db.prepare('DELETE FROM entity_mention_pending_docs WHERE doc_anchor=?');
          for (const anchor of input.docAnchors) clearPending.run(anchor);
        } else db.prepare('DELETE FROM entity_mention_pending_docs').run();
      }
      db.prepare("UPDATE entity_mention_generations SET phase='published' WHERE generation=?").run(generation);
    }).immediate();
    published = true;
    checkpoints.published = true;
    channel('cat-cafe.entity-mention-projection').publish({
      phase: 'published',
      generation,
      rows: cursor,
      publishMs: performance.now() - publicationStart,
    });
    try {
      await removeSupersededRows(db, projection, generation, checkpoints);
      await checkpoints.drain();
      // Finish fallible maintenance while its recovery receipt still exists.
      checkpoints.restore();
      db.prepare('DELETE FROM entity_mention_generations WHERE generation=?').run(generation);
    } catch (error) {
      // Publication already committed. Its persisted receipt lets startup resume
      // garbage collection; cleanup failure cannot revoke a successful approval.
      console.warn('[memory] Published mention cleanup deferred', error);
    }
  } finally {
    if (!published && generation !== undefined) {
      await deleteInBatches(db, 'entity_mention_rows', 'generation = ?', [generation]);
      db.prepare('DELETE FROM entity_mention_generations WHERE generation=?').run(generation);
    }
    if (attached) db.exec('DETACH DATABASE mention_stage');
    await rm(directory, { recursive: true, force: true }).catch((error) => {
      console.warn('[memory] Mention staging cleanup failed', error);
    });
  }
}

async function deleteInBatches(
  db: Database.Database,
  table: 'entity_mention_rows' | 'entity_mentions_legacy',
  predicate: string,
  params: unknown[],
  checkpoints?: ProjectionCheckpoints,
): Promise<void> {
  const statement = db.prepare(
    `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${predicate} LIMIT ${BATCH_SIZE})`,
  );
  for (;;) {
    await yieldToIo();
    if (statement.run(...params).changes === 0) return;
    await checkpoints?.afterBatch();
  }
}

async function removeSupersededRows(
  db: Database.Database,
  projection: MentionProjectionResult,
  generation: number,
  checkpoints?: ProjectionCheckpoints,
): Promise<void> {
  // Entity and document publication share one monotonically increasing sequence.
  // A later full entity projection supersedes every earlier row for that entity;
  // a later document projection similarly supersedes all earlier rows of that doc.
  const column = projection.entityIds ? 'entity_id' : 'doc_anchor';
  for (const id of projection.entityIds ?? projection.docAnchors ?? []) {
    await deleteInBatches(db, 'entity_mentions_legacy', `${column} = ?`, [id], checkpoints);
    await deleteInBatches(
      db,
      'entity_mention_rows',
      `${column} = ? AND generation < ?
      AND NOT EXISTS (SELECT 1 FROM entity_mention_generations in_flight
        WHERE in_flight.generation = entity_mention_rows.generation AND in_flight.phase = 'staging')`,
      [id, generation],
      checkpoints,
    );
  }
}

/** Resume interrupted derived-row cleanup without ever selecting an unpublished
 * generation. A live owner may still be staging on another store/connection. */
export async function recoverEntityMentionProjections(db: Database.Database): Promise<void> {
  const pending = db
    .prepare('SELECT generation, owner_pid, phase, scopes_json FROM entity_mention_generations')
    .all() as Array<{ generation: number; owner_pid: number; phase: string; scopes_json: string }>;
  for (const entry of pending) {
    if (isProcessAlive(entry.owner_pid)) continue;
    if (entry.phase === 'published') {
      await removeSupersededRows(db, JSON.parse(entry.scopes_json) as MentionProjectionResult, entry.generation);
    } else {
      await deleteInBatches(db, 'entity_mention_rows', 'generation = ?', [entry.generation]);
    }
    db.prepare('DELETE FROM entity_mention_generations WHERE generation=?').run(entry.generation);
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
