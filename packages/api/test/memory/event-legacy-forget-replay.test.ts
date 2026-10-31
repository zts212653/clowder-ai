import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import Database from 'better-sqlite3';
import { EventMemoryStore, eventMemoryRevision } from '../../src/domains/memory/EventMemoryStore.js';

// Frozen INSERT from EventMemoryStore.markEvent at accepted branch base 46a30be5fc.
// This is the historical writer shape, not the new tombstone-aware implementation.
const legacyInsert = `INSERT OR IGNORE INTO event_memory
  (eventId, type, trigger_type, cat, ownerUserId, threadId, messageId, timestamp, summary, cognitiveTransition, relatedHarness, confidence)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

it('keeps an owner-forgotten Event absent when the pre-lifecycle writer replays the same source', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'f321-event-legacy-'));
  const dbPath = join(directory, 'events.sqlite');
  const store = new EventMemoryStore(dbPath);
  await store.initialize();
  const record = {
    type: 'scope_correction',
    trigger: 'human_brake' as const,
    cat: 'codex61-sol',
    threadId: 'thread-a',
    messageId: 'source-a',
    timestamp: 100,
    summary: 'Source text must not resurrect the derived Event.',
    cognitiveTransition: null,
    relatedHarness: null,
    confidence: 'high' as const,
  };
  const event = store.markEvent(record, 'owner-a').event;
  assert.ok(event);
  const legacy = new Database(dbPath);
  const insert = (id: string, messageId: string) =>
    legacy
      .prepare(legacyInsert)
      .run(
        id,
        record.type,
        record.trigger,
        record.cat,
        'owner-a',
        record.threadId,
        messageId,
        record.timestamp,
        record.summary,
        null,
        null,
        record.confidence,
      );
  try {
    assert.equal(insert('legacy-control', 'control-source').changes, 1);
    assert.ok(store.getEvent('legacy-control'), 'The historical shape must be valid on the upgraded database');
    assert.equal(
      store.hardForgetEvent({
        eventId: event.eventId,
        ownerUserId: 'owner-a',
        expectedRevision: eventMemoryRevision(event),
        requestId: 'forget:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
      }).outcome,
      'forgotten',
    );
    assert.equal(store.hasHardForgetTombstone(event.eventId, 'owner-a'), true);
    try {
      insert('legacy-replayed', record.messageId);
    } catch (error) {
      assert.equal((error as { code?: string }).code, 'SQLITE_CONSTRAINT_TRIGGER');
    }
    assert.equal(store.getEvent('legacy-replayed'), null);
    assert.deepEqual(store.getByCoord(record.threadId, record.messageId, 'owner-a'), []);
  } finally {
    legacy.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('removes a legacy-resurrected row when a newer store reopens the database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'f321-event-legacy-reopen-'));
  const dbPath = join(directory, 'events.sqlite');
  const store = new EventMemoryStore(dbPath);
  await store.initialize();
  const record = {
    type: 'scope_correction',
    trigger: 'human_brake' as const,
    cat: 'codex61-sol',
    threadId: 'thread-reopen',
    messageId: 'source-reopen',
    timestamp: 101,
    summary: 'A stale writer replayed this row before the DB fence was deployed.',
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
      requestId: 'forget-reopen:018f2d5e-9f45-7d8c-a829-88f6440a4f15',
    }).outcome,
    'forgotten',
  );
  const legacy = new Database(dbPath);
  try {
    legacy.exec('DROP TRIGGER event_memory_forget_no_insert');
    legacy
      .prepare(legacyInsert)
      .run(
        'legacy-before-reopen',
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
      );
    assert.ok(store.getEvent('legacy-before-reopen'));
  } finally {
    legacy.close();
  }
  const reopened = new EventMemoryStore(dbPath);
  try {
    await reopened.initialize();
    assert.equal(reopened.getEvent('legacy-before-reopen'), null);
    assert.deepEqual(reopened.getByCoord(record.threadId, record.messageId, 'owner-a'), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
