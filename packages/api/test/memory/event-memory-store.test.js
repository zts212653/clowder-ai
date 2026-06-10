import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import Database from 'better-sqlite3';
import { EventMemoryStore } from '../../dist/domains/memory/EventMemoryStore.js';

/**
 * F227 PR-1 Task 2 — EventMemoryStore (memory cell, SQLite-backed).
 *
 * Tests run against a REAL SQLite engine (:memory:), not a JS in-memory mock —
 * so SQL filter / ordering / pagination behavior is exercised for real
 * (LL: in-memory-dense mocks hide index/pagination bugs).
 */

function baseRecord(overrides = {}) {
  return {
    type: 'scaffold',
    trigger: 'human_brake',
    cat: 'cat-opus',
    threadId: 'thread_a',
    messageId: 'msg_1',
    timestamp: 1000,
    summary: '脚手架',
    cognitiveTransition: 'user_brake',
    relatedHarness: null,
    confidence: 'high',
    ...overrides,
  };
}

describe('EventMemoryStore (F227 PR-1)', () => {
  /** @type {EventMemoryStore} */
  let store;
  const OWNER = 'owner-1';
  // markEvent now requires an owner scope (cloud-review P1); helper keeps existing tests terse.
  const mark = (record) => store.markEvent(record, OWNER);

  beforeEach(async () => {
    store = new EventMemoryStore(':memory:');
    await store.initialize();
  });

  describe('markEvent + getEvent', () => {
    it('mints evt_ eventId and returns the stored record (inserted=true)', () => {
      const { event: stored, inserted } = mark(baseRecord());
      assert.equal(inserted, true);
      assert.ok(stored.eventId.startsWith('evt_'), `expected evt_ prefix, got ${stored.eventId}`);
      assert.equal(stored.type, 'scaffold');
      assert.equal(stored.trigger, 'human_brake');
      assert.equal(stored.messageId, 'msg_1');
    });

    it('round-trips all fields via getEvent (deepEqual)', () => {
      const { event: stored } = mark(baseRecord({ relatedHarness: ['commit:abc', 'skill:tdd'] }));
      const got = store.getEvent(stored.eventId);
      assert.deepEqual(got, stored);
    });

    it('round-trips null nullable fields', () => {
      const { event: stored } = mark(baseRecord({ cognitiveTransition: null, relatedHarness: null }));
      const got = store.getEvent(stored.eventId);
      assert.equal(got.cognitiveTransition, null);
      assert.equal(got.relatedHarness, null);
    });

    it('mints unique eventIds for distinct coordinates', () => {
      const a = mark(baseRecord({ messageId: 'msg_1' }));
      const b = mark(baseRecord({ messageId: 'msg_2' }));
      assert.equal(a.inserted, true);
      assert.equal(b.inserted, true);
      assert.notEqual(a.event.eventId, b.event.eventId);
    });

    it('returns null for a missing eventId', () => {
      assert.equal(store.getEvent('evt_nope'), null);
    });
  });

  describe('listEvents — filter', () => {
    beforeEach(() => {
      mark(
        baseRecord({
          trigger: 'human_brake',
          cat: 'cat-opus',
          type: 'scaffold',
          threadId: 'thread_a',
          confidence: 'high',
          timestamp: 100,
        }),
      );
      mark(
        baseRecord({
          trigger: 'cat_brake',
          cat: 'cat-codex',
          type: 'detour',
          threadId: 'thread_a',
          confidence: 'low',
          timestamp: 200,
        }),
      );
      mark(
        baseRecord({
          trigger: 'lesson_settle',
          cat: 'cat-opus',
          type: 'lesson',
          threadId: 'thread_b',
          confidence: 'mid',
          timestamp: 300,
        }),
      );
    });

    it('filters by trigger', () => {
      const r = store.listEvents({ trigger: 'human_brake' });
      assert.equal(r.length, 1);
      assert.equal(r[0].trigger, 'human_brake');
    });

    it('filters by cat', () => {
      assert.equal(store.listEvents({ cat: 'cat-opus' }).length, 2);
    });

    it('filters by type', () => {
      assert.equal(store.listEvents({ type: 'detour' }).length, 1);
    });

    it('filters by threadId', () => {
      assert.equal(store.listEvents({ threadId: 'thread_a' }).length, 2);
    });

    it('filters by confidence', () => {
      assert.equal(store.listEvents({ confidence: 'low' }).length, 1);
    });

    it('combines filters with AND semantics', () => {
      assert.equal(store.listEvents({ cat: 'cat-opus', threadId: 'thread_a' }).length, 1);
    });

    it('filters by time window (since/until inclusive)', () => {
      const r = store.listEvents({ since: 150, until: 250 });
      assert.equal(r.length, 1);
      assert.equal(r[0].timestamp, 200);
    });

    it('returns all events when no filter', () => {
      assert.equal(store.listEvents().length, 3);
    });
  });

  describe('listEvents — order + pagination', () => {
    beforeEach(() => {
      for (let i = 1; i <= 5; i++) {
        mark(baseRecord({ messageId: `msg_${i}`, timestamp: i * 100 }));
      }
    });

    it('returns newest first (timestamp DESC)', () => {
      const r = store.listEvents();
      assert.equal(r[0].timestamp, 500);
      assert.equal(r[4].timestamp, 100);
    });

    it('respects limit', () => {
      assert.equal(store.listEvents({ limit: 2 }).length, 2);
    });

    it('respects offset for stable paging', () => {
      const page1 = store.listEvents({ limit: 2, offset: 0 });
      const page2 = store.listEvents({ limit: 2, offset: 2 });
      assert.equal(page1[0].timestamp, 500);
      assert.equal(page1[1].timestamp, 400);
      assert.equal(page2[0].timestamp, 300);
      assert.equal(page2[1].timestamp, 200);
    });
  });

  describe('getByCoord (teleport reverse lookup)', () => {
    it('returns events at a (threadId, messageId) coordinate', () => {
      mark(baseRecord({ threadId: 'thread_a', messageId: 'msg_x' }));
      mark(baseRecord({ threadId: 'thread_a', messageId: 'msg_y' }));
      const r = store.getByCoord('thread_a', 'msg_x');
      assert.equal(r.length, 1);
      assert.equal(r[0].messageId, 'msg_x');
    });

    it('returns empty array for an unknown coordinate', () => {
      assert.deepEqual(store.getByCoord('thread_z', 'msg_none'), []);
    });
  });

  describe('health', () => {
    it('reports healthy after initialize', () => {
      assert.equal(store.health(), true);
    });
  });

  describe('markEvent guard (砚砚 non-blocking)', () => {
    it('throws on an invalid record (missing fields)', () => {
      assert.throws(() => mark({ type: 'x' }), /isEventMemoryRecord guard/);
    });

    it('throws on a bad enum value', () => {
      assert.throws(() => mark(baseRecord({ trigger: 'bogus' })), /isEventMemoryRecord guard/);
    });
  });

  describe('dead-letter (P1-3 — 最终不丢)', () => {
    it('appends a failed record and reads it back via listDeadLetter', () => {
      const rec = baseRecord();
      store.appendDeadLetter(rec, OWNER, 'simulated write failure');
      const entries = store.listDeadLetter();
      assert.equal(entries.length, 1);
      assert.deepEqual(entries[0].record, rec);
      assert.equal(entries[0].ownerUserId, OWNER, 'owner captured for safe replay (P1)');
      assert.equal(entries[0].error, 'simulated write failure');
      assert.ok(typeof entries[0].failedAt === 'number');
    });

    it('accumulates multiple dead-letters', () => {
      store.appendDeadLetter(baseRecord({ messageId: 'm1' }), OWNER, 'e1');
      store.appendDeadLetter(baseRecord({ messageId: 'm2' }), OWNER, 'e2');
      assert.equal(store.listDeadLetter().length, 2);
    });

    it('listDeadLetter is empty when nothing has failed', () => {
      assert.deepEqual(store.listDeadLetter(), []);
    });
  });

  describe('markEvent — atomic idempotency on (threadId, messageId, type) [cloud-review P1]', () => {
    it('a duplicate coord+type is ignored and returns the existing event (no double write)', () => {
      const first = mark(baseRecord());
      const second = mark(baseRecord({ summary: '同坐标同类型、不同摘要' }));
      assert.equal(first.inserted, true);
      assert.equal(second.inserted, false, 'duplicate coord+type must not insert again');
      assert.equal(second.event.eventId, first.event.eventId, 'live path still resolves to the existing eventId');
      assert.equal(store.listEvents().length, 1, 'exactly one row at the coordinate');
    });

    it('the same message with a different type is a distinct event', () => {
      const a = mark(baseRecord({ type: 'scaffold' }));
      const b = mark(baseRecord({ type: 'detour' }));
      assert.equal(a.inserted, true);
      assert.equal(b.inserted, true);
      assert.equal(store.getByCoord('thread_a', 'msg_1').length, 2);
    });

    it('on a race, a higher-confidence writer upgrades the row; lower never downgrades [cloud-review P2]', () => {
      // backfill grades mid first; the live high write for the SAME coord+type must upgrade
      // it (confidence + metadata) — a real live brake is never stuck at a backfill grade.
      const first = mark(baseRecord({ confidence: 'mid', cat: 'unknown' }));
      const second = mark(baseRecord({ confidence: 'high', cat: 'opus' }));
      assert.equal(first.inserted, true);
      assert.equal(second.inserted, false, 'no new row on the same coord+type');
      assert.equal(store.listEvents().length, 1, 'still exactly one row');
      let [e] = store.listEvents();
      assert.equal(e.confidence, 'high', 'higher-confidence writer wins the race');
      assert.equal(e.cat, 'opus', 'metadata upgraded to the higher-confidence (live) writer');

      // reverse order: a later mid must NOT downgrade the high or clobber its metadata
      mark(baseRecord({ confidence: 'mid', cat: 'codex' }));
      [e] = store.listEvents();
      assert.equal(e.confidence, 'high', 'lower confidence does not downgrade');
      assert.equal(e.cat, 'opus', 'metadata not clobbered by the lower-confidence writer');
    });
  });

  describe('owner scope [cloud-review P1]', () => {
    it('markEvent requires a non-empty owner (no fallback)', () => {
      assert.throws(() => store.markEvent(baseRecord(), ''), /ownerUserId is required/);
    });

    it('two owners at the same coordinate are separate, owner-filtered events', () => {
      store.markEvent(baseRecord(), 'owner-A');
      store.markEvent(baseRecord(), 'owner-B'); // same coord+type, different owner → distinct
      assert.equal(store.listEvents().length, 2, 'different owners do not collide on the unique key');
      assert.equal(store.listEvents({ ownerUserId: 'owner-A' }).length, 1);
      assert.equal(store.listEvents({ ownerUserId: 'owner-A' })[0].ownerUserId, 'owner-A');
      assert.equal(store.listEvents({ ownerUserId: 'owner-B' }).length, 1);
    });

    it('getByCoord owner-scopes when an owner is supplied', () => {
      store.markEvent(baseRecord({ messageId: 'm_x' }), 'owner-A');
      store.markEvent(baseRecord({ messageId: 'm_x' }), 'owner-B');
      assert.equal(store.getByCoord('thread_a', 'm_x').length, 2, 'unscoped reverse-lookup sees both');
      assert.equal(store.getByCoord('thread_a', 'm_x', 'owner-A').length, 1, 'scoped sees only owner-A');
      assert.equal(store.getByCoord('thread_a', 'm_x', 'owner-A')[0].ownerUserId, 'owner-A');
    });
  });

  describe('migration tolerates pre-existing duplicates [cloud-review P1]', () => {
    it('dedups legacy duplicate coord+type rows on initialize instead of failing', async () => {
      // Simulate a DB written by the pre-guard (check-then-act) code: two rows share
      // (threadId, messageId, type). initialize() must dedup, not throw on the UNIQUE index.
      const dir = mkdtempSync(join(tmpdir(), 'evmem-mig-'));
      const dbPath = join(dir, 'legacy.db');
      try {
        const raw = new Database(dbPath);
        raw.exec(`
          CREATE TABLE event_memory (
            eventId TEXT PRIMARY KEY, type TEXT NOT NULL, trigger_type TEXT NOT NULL,
            cat TEXT NOT NULL, threadId TEXT NOT NULL, messageId TEXT NOT NULL,
            timestamp INTEGER NOT NULL, summary TEXT NOT NULL, cognitiveTransition TEXT,
            relatedHarness TEXT, confidence TEXT NOT NULL
          );
        `);
        const ins = raw.prepare(
          `INSERT INTO event_memory
            (eventId, type, trigger_type, cat, threadId, messageId, timestamp, summary, cognitiveTransition, relatedHarness, confidence)
           VALUES (?, 'scaffold', 'human_brake', 'cat-opus', 'thread_a', 'msg_1', 1000, ?, 'user_brake', NULL, 'high')`,
        );
        ins.run('evt_legacy_1', 'first');
        ins.run('evt_legacy_2', 'dup'); // same (thread_a, msg_1, scaffold) — a legacy duplicate
        raw.close();

        const migrated = new EventMemoryStore(dbPath);
        await migrated.initialize(); // must NOT throw on CREATE UNIQUE INDEX
        assert.equal(migrated.listEvents().length, 1, 'legacy duplicate collapsed to one row');
        // post-migration the owner-scoped guard holds: a first OWNED write is new (legacy
        // rows carry the '' default owner from the ALTER), a repeat at the same
        // owner+coord+type is idempotent.
        assert.equal(migrated.markEvent(baseRecord(), OWNER).inserted, true);
        assert.equal(migrated.markEvent(baseRecord(), OWNER).inserted, false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
