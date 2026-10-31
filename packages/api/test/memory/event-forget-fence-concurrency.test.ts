import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { EventMemoryStore, eventMemoryRevision } from '../../src/domains/memory/EventMemoryStore.js';
import { installEventMemoryForgetFence } from '../../src/domains/memory/event/event-memory-forget-fence.js';

const workerSource = `
  const { workerData, parentPort } = require('node:worker_threads');
  const Database = require(workerData.module);
  const flags = new Int32Array(workerData.flags);
  let db;
  try {
    db = new Database(workerData.path);
    db.pragma('busy_timeout = 0');
    Atomics.store(flags, 0, 1); Atomics.notify(flags, 0);
    if (Atomics.wait(flags, 0, 1, 5000) === 'timed-out') throw new Error('installer did not release worker');
    const info = db.prepare(workerData.sql).run(...workerData.values);
    Atomics.store(flags, 1, info.changes === 1 ? 1 : 0);
  } catch (error) {
    Atomics.store(flags, 1, error.code === 'SQLITE_BUSY' ? 2 : error.code === 'SQLITE_CONSTRAINT_TRIGGER' ? 3 : 4);
  } finally {
    if (db) db.close();
    Atomics.store(flags, 0, 3); Atomics.notify(flags, 0); parentPort.close();
  }
`;

it('does not let a concurrent legacy writer slip between cleanup and trigger installation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'f321-event-fence-race-'));
  const dbPath = join(directory, 'events.sqlite');
  const store = new EventMemoryStore(dbPath);
  await store.initialize();
  const record = {
    type: 'scope_correction',
    trigger: 'human_brake' as const,
    cat: 'codex61-sol',
    threadId: 'thread-concurrent',
    messageId: 'source-concurrent',
    timestamp: 100,
    summary: 'A forgotten Event must stay absent through every-open reconciliation.',
    cognitiveTransition: null,
    relatedHarness: null,
    confidence: 'high' as const,
  };
  const event = store.markEvent(record, 'owner-a').event;
  assert.ok(event);
  assert.equal(
    store.hardForgetEvent({
      eventId: event.eventId,
      ownerUserId: 'owner-a',
      expectedRevision: eventMemoryRevision(event),
      requestId: 'forget-concurrent:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
    }).outcome,
    'forgotten',
  );
  const flags = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(workerSource, {
    eval: true,
    workerData: {
      module: createRequire(import.meta.url).resolve('better-sqlite3'),
      path: dbPath,
      flags: flags.buffer,
      sql: `INSERT OR IGNORE INTO event_memory
      (eventId, type, trigger_type, cat, ownerUserId, threadId, messageId, timestamp, summary, cognitiveTransition, relatedHarness, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values: [
        'legacy-interleaved',
        record.type,
        record.trigger,
        record.cat,
        'owner-a',
        record.threadId,
        record.messageId,
        record.timestamp,
        record.summary,
        null,
        null,
        record.confidence,
      ],
    },
  });
  assert.notEqual(Atomics.wait(flags, 0, 0, 5000), 'timed-out', 'legacy worker must open before the installer');
  assert.equal(Atomics.load(flags, 0), 1);
  let synchronized = false;
  const db = new Database(dbPath, {
    verbose: (sql) => {
      if (!/^\s*CREATE TRIGGER event_memory_forget_no_insert\b/.test(sql)) return;
      synchronized = true;
      Atomics.store(flags, 0, 2);
      Atomics.notify(flags, 0);
      assert.notEqual(
        Atomics.wait(flags, 0, 2, 5000),
        'timed-out',
        'concurrent writer must return while the installer is paused',
      );
    },
  });
  try {
    installEventMemoryForgetFence(db);
    assert.equal(synchronized, true, 'SQLite trace must observe the real CREATE after DROP');
    assert.notEqual(Atomics.load(flags, 1), 4, 'the legacy write must reach a known SQLite outcome');
    assert.equal(store.getEvent('legacy-interleaved'), null);
  } finally {
    db.close();
    await worker.terminate();
    rmSync(directory, { recursive: true, force: true });
  }
});
