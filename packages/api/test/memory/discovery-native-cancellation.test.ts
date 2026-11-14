import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { KnowledgeResolver } from '../../src/domains/memory/KnowledgeResolver.js';
import type { DiscoveryReadRequest } from '../../src/domains/memory/knowledge-discovery.js';
import type { MemoryReadSnapshot } from '../../src/domains/memory/memory-read-execution.js';
import type { MessagePassageSearchOptions } from '../../src/domains/memory/message-passage-search-types.js';
import { runMessageSearch } from '../../src/domains/memory/message-search-run.js';
import { SqliteEvidenceStore } from '../../src/domains/memory/SqliteEvidenceStore.js';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  'discovery closes an owned native read on an outer deadline and on sibling failure',
  { timeout: 15000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'discovery-native-cancel-'));
    const store = new SqliteEvidenceStore(join(root, 'neutral.sqlite'));
    await store.initialize();
    t.after(() => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    });
    const db = store.getDb();
    db.prepare(
      "INSERT INTO evidence_docs(anchor,kind,status,title,updated_at) VALUES('thread-neutral','thread','active','Neutral','2026-01-01')",
    ).run();
    const insert = db.prepare(
      "INSERT INTO evidence_passages(doc_anchor,passage_id,content,position,created_at) VALUES('thread-neutral',?,?,?,'2026-01-01')",
    );
    db.transaction(() => {
      for (let i = 0; i < 4096; i++) insert.run(`msg-${i}`, '甲'.repeat(2048), i);
    })();
    const query = Array.from({ length: 900 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join(' ');
    for (const kind of ['deadline', 'sibling-failure'] as const) {
      await t.test(kind, async (sub) => {
        await store.searchMessagePassages('absentneutral', {
          mode: 'lexical',
          visibleThreadIds: ['neutral'],
          deadlineAt: Date.now() + 5000,
        });
        const parent = new AbortController();
        const snapshots: MemoryReadSnapshot[] = [];
        let nativePid: number | undefined;
        let restoreClock = () => {};
        let signal: AbortSignal | undefined;
        let unblock!: () => void;
        const nativeStarted = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        sub.after(() => {
          restoreClock();
          if (nativePid && alive(nativePid)) process.kill(nativePid, 'SIGKILL');
        });
        const retrieve = (text: string, options: MessagePassageSearchOptions) => {
          signal = options.signal;
          return store.searchMessagePassages(text, {
            ...options,
            onReadSnapshot(snapshot) {
              snapshots.push(snapshot);
              options.onReadSnapshot?.(snapshot);
              if (!nativePid && snapshot.cjk?.outcome === 'running') {
                nativePid = snapshot.pid;
                assert.ok(nativePid);
                process.kill(nativePid, 'SIGSTOP');
                restoreClock();
                unblock();
              }
            },
          });
        };
        const failure = new Error('another source failed after native start');
        if (kind === 'deadline') {
          // Control only timer registration order. Restore wall time at the actual
          // native checkpoint; the existing deadline then expires in real time.
          const now = Date.now;
          const frozen = now();
          sub.mock.method(Date, 'now', () => frozen);
          restoreClock = () => sub.mock.restoreAll();
          const pending = runMessageSearch(
            { query, mode: 'lexical', sort: 'relevance', limit: 1 },
            { userId: 'owner', viewer: { type: 'user' } },
            { signal: parent.signal, deadlineAt: frozen + 1500 },
            {
              visible: async () =>
                new Map([
                  [
                    'neutral',
                    {
                      id: 'neutral',
                      createdBy: 'owner',
                      title: 'Neutral',
                      projectPath: 'default',
                      participants: [],
                      createdAt: 1,
                      lastActiveAt: 1,
                    },
                  ],
                ]),
              requireSource: async () => {},
              retrieve,
              project: async () => null,
              projectWave: async () => [],
              resetAuthority() {},
              decisionIndex: { lookup: async () => ({ status: 'unavailable', facts: new Map() }) },
            },
          );
          await assert.rejects(
            pending,
            (error: Error & { messageSearchExecution?: { workerReads: MemoryReadSnapshot[] } }) => {
              assert.equal(error.name, 'TimeoutError');
              assert.equal(error.messageSearchExecution?.workerReads.at(-1)?.outcome, 'rejected');
              return true;
            },
          );
        } else {
          await assert.rejects(
            KnowledgeResolver.discover(query, {
              signal: parent.signal,
              deadlineAt: Date.now() + 4000,
              limit: 1,
              sources: [
                {
                  id: 'native',
                  read: async (request: DiscoveryReadRequest) => ({
                    candidates: (await retrieve(query, { ...request, mode: 'lexical', visibleThreadIds: ['neutral'] }))
                      .passages,
                  }),
                  project: async () => null,
                  key: () => 'unused',
                },
                {
                  id: 'fails',
                  read: async () => {
                    await nativeStarted;
                    throw failure;
                  },
                  project: async () => null,
                  key: () => 'unused',
                },
              ],
            }),
            (error) => error === failure,
          );
        }
        assert.ok(nativePid, 'the real SQLite matcher must have reached its callback checkpoint');
        assert.equal(parent.signal.aborted, false, 'owned cleanup cannot abort the external caller');
        assert.equal(signal?.aborted, true);
        assert.equal(snapshots.at(-1)?.outcome, 'rejected', 'terminal observer runs before discovery returns');
        assert.equal(snapshots.at(-1)?.cjk?.complete, false, 'a killed read has no SQL completion');
        for (let i = 0; i < 100 && alive(nativePid); i++) await pause(10);
        assert.equal(alive(nativePid), false, 'the fixture child must actually exit');
      });
    }
  },
);
