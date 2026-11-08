import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'message-queue-worker-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.upsert(
    ['visible', 'private'].map((id) => ({
      anchor: `thread-${id}`,
      kind: 'thread',
      status: 'active',
      title: 'Queue IPC fixture',
      updatedAt: '2026-11-01',
    })),
  );
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const vectors = new PassageVectorStore(db, 4);
  const insert = db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES (?,?,?,?)');
  for (const [id, thread, body, date, vector] of [
    ['semantic', 'visible', '新伙伴的称呼在这里敲定。', '2026-01-01', [1, 0, 0, 0]],
    ...Array.from({ length: 5 }, (_, i) => [
      `retelling-${i}`,
      'visible',
      `Cedar 取名 转述${i}。`,
      '2026-06-01',
      i === 0 ? [0.9, 0.1, 0, 0] : [0, 1, 0, 0],
    ]),
    ['current', 'visible', 'Cedar 取名', '2026-06-02', [1, 0, 0, 0]],
    ['secret', 'private', 'Cedar 取名', '2026-01-01', [1, 0, 0, 0]],
  ]) {
    insert.run(`thread-${thread}`, `msg-${id}`, body, date);
    vectors.upsert(passageVectorKey(`thread-${thread}`, `msg-${id}`), new Float32Array(vector));
  }
  let calls = 0;
  store.setEmbedDeps({
    mode: 'on',
    vectorStore: new VectorStore(db, 4),
    passageVectorStore: vectors,
    embedding: {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      isReady: () => true,
      getModelInfo: () => ({ modelId: 'queue-ipc', modelRev: '1', dim: 4 }),
      embed: async (texts) => {
        calls++;
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    },
  });
  return { store, calls: () => calls };
}

test('real message worker carries the queue selector, filters and RRF order for both display sorts', async (t) => {
  const f = await fixture(t);
  const options = {
    visibleThreadIds: ['visible'],
    mode: 'hybrid',
    candidateLimit: 4,
    excludeSource: { threadId: 'visible', messageId: 'current' },
    deadlineAt: Date.now() + 10_000,
  };
  const legacy = await f.store.searchMessagePassages('Cedar 取名', { ...options, sort: 'relevance' });
  assert.ok(legacy.passages.every((p) => p.messageId !== 'semantic'));
  let relevance;
  for (const sort of ['time', 'relevance']) {
    const snapshots = [];
    const value = await f.store.searchMessagePassages('Cedar 取名', {
      ...options,
      sort,
      candidateOrder: 'relevance',
      onReadSnapshot: (s) => snapshots.push(s),
    });
    assert.equal(snapshots.at(-1)?.kind, 'message-search');
    assert.equal(snapshots.at(-1)?.outcome, 'fulfilled');
    assert.ok(snapshots.at(-1)?.pid > 0, 'the selector must cross a real file-worker IPC boundary');
    assert.deepEqual(
      value.passages.slice(0, 2).map((p) => p.messageId),
      ['retelling-0', 'semantic'],
    );
    assert.equal(value.meta.sort, 'relevance');
    assert.equal(value.meta.effectiveMode, 'hybrid');
    assert.equal(value.meta.degraded, false);
    assert.ok(value.passages.every((p) => p.threadId === 'visible' && p.messageId !== 'current'));
    if (relevance) assert.deepEqual(value, relevance);
    relevance = value;
  }
  assert.equal(f.calls(), 3, 'all embeddings are served by the controlled parent RPC fixture');
});

test('queue selector preserves pre-worker cancellation and the original absolute deadline', async (t) => {
  const f = await fixture(t);
  const options = { visibleThreadIds: ['visible'], mode: 'hybrid', candidateOrder: 'relevance' };
  const controller = new AbortController();
  controller.abort(new DOMException('caller left', 'AbortError'));
  await assert.rejects(f.store.searchMessagePassages('Cedar 取名', { ...options, signal: controller.signal }), {
    name: 'AbortError',
  });
  await assert.rejects(f.store.searchMessagePassages('Cedar 取名', { ...options, deadlineAt: Date.now() - 1 }), {
    name: 'TimeoutError',
  });
  assert.equal(f.calls(), 0);
});
