/* eslint-disable @typescript-eslint/no-explicit-any -- test stubs use partial objects */
import { deleteDB, openDB } from 'idb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  _closeDBForTest,
  _getDBForTest,
  _resetDBForTest,
  clearAll,
  loadThreadMessages,
  loadThreads,
  saveThreadMessages,
  saveThreads,
} from '../offline-store';

// Open the DB at whatever version the production code uses (no pinned version)
// so the existing pollution helpers keep working after a schema bump.
async function openCurrentVersionDB() {
  return openDB('cat-cafe-offline');
}

// Write a polluted snapshot directly, bypassing saveThreadMessages' save-side filter.
// Simulates a client that was running the pre-fix build and left isStreaming placeholders
// in their IndexedDB.
async function rawPutPollutedSnapshot(threadId: string, messages: any[], hasMore = false): Promise<void> {
  const db = await openCurrentVersionDB();
  await db.put('thread-messages', { threadId, messages, hasMore, updatedAt: Date.now() });
  db.close();
}

async function rawGetSnapshot(threadId: string): Promise<any> {
  const db = await openCurrentVersionDB();
  const record = await db.get('thread-messages', threadId);
  db.close();
  return record;
}

describe('offline-store', () => {
  beforeEach(async () => {
    await clearAll();
  });

  afterAll(() => {
    _resetDBForTest();
  });

  describe('threads', () => {
    it('returns null when no threads saved', async () => {
      const result = await loadThreads();
      expect(result).toBeNull();
    });

    it('saves and loads threads', async () => {
      const threads = [{ id: 'thread_1', title: 'Test Thread', projectPath: 'default' }] as any[];
      await saveThreads(threads);
      const loaded = await loadThreads();
      expect(loaded).toHaveLength(1);
      expect(loaded![0].id).toBe('thread_1');
    });

    it('overwrites previous threads on re-save', async () => {
      await saveThreads([{ id: 't1' }] as any[]);
      await saveThreads([{ id: 't2' }, { id: 't3' }] as any[]);
      const loaded = await loadThreads();
      expect(loaded).toHaveLength(2);
      expect(loaded![0].id).toBe('t2');
    });
  });

  describe('thread messages', () => {
    it('returns null when no messages saved', async () => {
      const result = await loadThreadMessages('thread_1');
      expect(result).toBeNull();
    });

    it('saves and loads messages for a thread', async () => {
      const messages = [
        { id: 'msg_1', content: [{ type: 'text', text: 'hello' }] },
        { id: 'msg_2', content: [{ type: 'text', text: 'world' }] },
      ] as any[];
      await saveThreadMessages('thread_1', messages, true);
      const result = await loadThreadMessages('thread_1');
      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(2);
      expect(result!.hasMore).toBe(true);
    });

    it('trims to last 50 messages', async () => {
      const messages = Array.from({ length: 80 }, (_, i) => ({
        id: `msg_${i}`,
        content: [{ type: 'text', text: `msg ${i}` }],
      })) as any[];
      await saveThreadMessages('thread_1', messages, true);
      const result = await loadThreadMessages('thread_1');
      expect(result!.messages).toHaveLength(50);
      expect(result!.messages[0].id).toBe('msg_30');
    });

    it('saving empty messages overwrites existing snapshot', async () => {
      await saveThreadMessages('t1', [{ id: 'm1' }] as any[], true);
      // Simulate thread cleared server-side: save empty array
      await saveThreadMessages('t1', [], false);
      const result = await loadThreadMessages('t1');
      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(0);
      expect(result!.hasMore).toBe(false);
    });

    it('stores messages per-thread independently', async () => {
      await saveThreadMessages('t1', [{ id: 'm1' }] as any[], false);
      await saveThreadMessages('t2', [{ id: 'm2' }] as any[], true);
      const r1 = await loadThreadMessages('t1');
      const r2 = await loadThreadMessages('t2');
      expect(r1!.messages[0].id).toBe('m1');
      expect(r2!.messages[0].id).toBe('m2');
    });

    it('filters out isStreaming placeholder messages before persisting', async () => {
      const messages = [
        { id: 'msg_finished_1', content: [{ type: 'text', text: 'done' }] },
        { id: 'msg_streaming', isStreaming: true, content: [{ type: 'text', text: 'partial' }] },
        { id: 'msg_finished_2', content: [{ type: 'text', text: 'done too' }] },
      ] as any[];
      await saveThreadMessages('thread_1', messages, false);
      const result = await loadThreadMessages('thread_1');
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages.map((m: any) => m.id)).toEqual(['msg_finished_1', 'msg_finished_2']);
    });

    it('filters out isStreaming from an already-polluted snapshot on load (old-client migration)', async () => {
      await rawPutPollutedSnapshot('t1', [{ id: 'm1' }, { id: 'm2_streaming', isStreaming: true }, { id: 'm3' }]);
      const result = await loadThreadMessages('t1');
      expect(result!.messages.map((m: any) => m.id)).toEqual(['m1', 'm3']);
    });

    it('rewrites cleaned snapshot back to IDB after loading polluted data (self-heal)', async () => {
      await rawPutPollutedSnapshot('t1', [{ id: 'm1' }, { id: 'm_stream', isStreaming: true }]);
      await loadThreadMessages('t1');
      const raw = await rawGetSnapshot('t1');
      expect(raw.messages.map((m: any) => m.id)).toEqual(['m1']);
      expect(raw.messages.every((m: any) => !m.isStreaming)).toBe(true);
    });

    it('still returns filtered messages when self-heal write-back fails', async () => {
      await rawPutPollutedSnapshot('t1', [{ id: 'm1' }, { id: 'm_stream', isStreaming: true }, { id: 'm2' }]);
      const db = await _getDBForTest();
      const origPut = db.put.bind(db);
      db.put = (() => Promise.reject(new Error('IDB write failure (simulated)'))) as any;
      let result: Awaited<ReturnType<typeof loadThreadMessages>>;
      try {
        result = await loadThreadMessages('t1');
      } finally {
        db.put = origPut;
      }
      expect(result).not.toBeNull();
      expect(result!.messages.map((m: any) => m.id)).toEqual(['m1', 'm2']);
    });
  });

  describe('clearAll', () => {
    it('removes all cached data', async () => {
      await saveThreads([{ id: 't1' }] as any[]);
      await saveThreadMessages('t1', [{ id: 'm1' }] as any[], false);
      await clearAll();
      expect(await loadThreads()).toBeNull();
      expect(await loadThreadMessages('t1')).toBeNull();
    });
  });

  // F183 Phase D AC-D2 — cachedFrom='idb' marker is the signal mergeReplace
  // uses to differentiate cache-derived messages from live state. Marker is
  // applied at load (so callers don't have to remember) and stripped at save
  // (so it doesn't survive in the persisted snapshot).
  describe('AC-D2 cachedFrom marker', () => {
    it('stamps cachedFrom="idb" on every loaded message', async () => {
      const messages = [
        { id: 'm1', content: [{ type: 'text', text: 'hello' }] },
        { id: 'm2', content: [{ type: 'text', text: 'world' }] },
      ] as any[];
      await saveThreadMessages('thread_1', messages, false);
      const result = await loadThreadMessages('thread_1');
      expect(result!.messages.every((m: any) => m.cachedFrom === 'idb')).toBe(true);
    });

    it('strips cachedFrom from input before persisting (round-trip stays clean)', async () => {
      const messages = [
        { id: 'm1', cachedFrom: 'idb', content: [{ type: 'text', text: 'a' }] },
        { id: 'm2', content: [{ type: 'text', text: 'b' }] },
      ] as any[];
      await saveThreadMessages('thread_1', messages, false);
      // Read raw — confirms the persisted record has no cachedFrom field
      const raw = await rawGetSnapshot('thread_1');
      expect(raw.messages.every((m: any) => m.cachedFrom === undefined)).toBe(true);
    });

    it('also strips cachedFrom from polluted-snapshot self-heal write-back', async () => {
      // Pre-existing client wrote a snapshot containing both cachedFrom and isStreaming
      await rawPutPollutedSnapshot('t1', [
        { id: 'm1', cachedFrom: 'idb' },
        { id: 'm_stream', isStreaming: true },
      ]);
      await loadThreadMessages('t1');
      const raw = await rawGetSnapshot('t1');
      // Self-heal writeback must also strip cachedFrom
      expect(raw.messages.every((m: any) => m.cachedFrom === undefined)).toBe(true);
    });
  });

  // F183 Phase D AC-D1 — schema-version invalidation. When DB_VERSION bumps
  // (because identity contract changed), the upgrade hook drops stale stores
  // so cache can't pollute UI with messages stamped by the old contract.
  describe('AC-D1 schema-version invalidation', () => {
    it('drops stale stores when DB version bumps from a prior schema', async () => {
      // Tear down any prior DB so we can re-create at v1 (legacy client state).
      // Must close before delete or fake-indexeddb blocks indefinitely.
      await _closeDBForTest();
      await deleteDB('cat-cafe-offline');
      // Simulate a legacy client: open at v1 with the old schema, populate
      const legacyDb = await openDB('cat-cafe-offline', 1, {
        upgrade(db) {
          if (!db.objectStoreNames.contains('threads')) {
            db.createObjectStore('threads', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('thread-messages')) {
            db.createObjectStore('thread-messages', { keyPath: 'threadId' });
          }
        },
      });
      await legacyDb.put('threads', { id: 'thread-list', threads: [{ id: 'stale' }], updatedAt: Date.now() });
      await legacyDb.put('thread-messages', {
        threadId: 't-stale',
        messages: [{ id: 'stale-msg' }],
        hasMore: false,
        updatedAt: Date.now(),
      });
      legacyDb.close();
      // Now open via production code (DB_VERSION=2). Upgrade hook drops the
      // pre-existing stores; reads see empty state.
      _resetDBForTest();
      const threadsAfterUpgrade = await loadThreads();
      const messagesAfterUpgrade = await loadThreadMessages('t-stale');
      expect(threadsAfterUpgrade).toBeNull();
      expect(messagesAfterUpgrade).toBeNull();
    });

    it('is a no-op for fresh installs (oldVersion === 0)', async () => {
      // Tear down so we open completely fresh
      await _closeDBForTest();
      await deleteDB('cat-cafe-offline');
      // First call: should create stores cleanly without throwing
      await saveThreads([{ id: 't-fresh' }] as any[]);
      const threads = await loadThreads();
      expect(threads).toHaveLength(1);
      expect(threads![0].id).toBe('t-fresh');
    });
  });
});
