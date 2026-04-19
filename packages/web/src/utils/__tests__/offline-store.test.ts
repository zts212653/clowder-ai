/* eslint-disable @typescript-eslint/no-explicit-any -- test stubs use partial objects */
import { openDB } from 'idb';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import {
  _getDBForTest,
  _resetDBForTest,
  clearAll,
  loadThreadMessages,
  loadThreads,
  saveThreadMessages,
  saveThreads,
} from '../offline-store';

// Write a polluted snapshot directly, bypassing saveThreadMessages' save-side filter.
// Simulates a client that was running the pre-fix build and left isStreaming placeholders
// in their IndexedDB.
async function rawPutPollutedSnapshot(threadId: string, messages: any[], hasMore = false): Promise<void> {
  const db = await openDB('cat-cafe-offline', 1);
  await db.put('thread-messages', { threadId, messages, hasMore, updatedAt: Date.now() });
  db.close();
}

async function rawGetSnapshot(threadId: string): Promise<any> {
  const db = await openDB('cat-cafe-offline', 1);
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
});
