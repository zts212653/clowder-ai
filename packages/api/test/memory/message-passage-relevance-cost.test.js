import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

test(
  'file-backed ranking handles the full legal query across thousands of passages inside its deadline',
  { timeout: 30_000 },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'message-relevance-cost-'));
    const dbPath = join(root, 'evidence.sqlite');
    const seed = new SqliteEvidenceStore(dbPath);
    t.after(() => {
      seed.close();
      rmSync(root, { recursive: true, force: true });
    });
    await seed.initialize();
    await seed.upsert([
      { anchor: 'thread-bulk', kind: 'thread', status: 'active', title: 'bulk', updatedAt: '2026-10-01T00:00:00Z' },
    ]);
    const words = Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + i));
    const query = words.join(' ');
    assert.equal(query.length, 1999);
    const insert = seed
      .getDb()
      .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
    seed.getDb().transaction(() => {
      for (let i = 0; i < 3077; i++) {
        // Match the final query term: an OR that scans words is also expensive.
        const content = words.at(-1) + String(i).padStart(4, '0') + '甲'.repeat(995);
        insert.run('thread-bulk', `msg-noise-${i}`, content, '2026-10-01T00:00:00Z');
      }
      insert.run('thread-bulk', 'msg-source', words.join('、'), '2026-10-01T00:00:00Z');
    })();
    seed.close();
    const reader = new SqliteEvidenceStore(dbPath);
    await reader.initialize();
    t.after(() => reader.close());
    const options = { visibleThreadIds: ['bulk'], mode: 'lexical', sort: 'relevance', candidateLimit: 2000 };
    const started = performance.now();
    const result = await reader.searchMessagePassages(query, options);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 15_000, `fixed product deadline exceeded: ${elapsedMs}ms`);
    assert.equal(result.passages.length, 2000);
    assert.equal(result.passages[0]?.messageId, 'source', 'all distinct query terms still contribute');
    assert.equal(result.meta.candidateLimit, 2000);
    t.diagnostic(`3078 passages / 1000 distinct terms / 1999 chars: ${elapsedMs.toFixed(1)}ms`);
    const time = await reader.searchMessagePassages(query, { ...options, sort: 'time' });
    assert.equal(time.passages.length, 2000, 'CJK membership must also avoid per-term rescans in time mode');
    const rebound = await reader.searchMessagePassages('不存在', options);
    assert.deepEqual(rebound.passages, [], 'connection-local matching uses the current query');
  },
);
