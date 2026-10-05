import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { RunLedger } from '../../dist/infrastructure/scheduler/RunLedger.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'index-contract-'));
  const docs = join(root, 'docs');
  mkdirSync(join(docs, 'features'), { recursive: true });
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, docs, store };
}
test('startup, force and incremental scans retain complete document passages after a failed discovery', async (t) => {
  const { docs, store } = await fixture(t);
  const path = join(docs, 'features', 'F001-doc.md');
  writeFileSync(path, '---\nfeature_ids: [F001]\n---\n# Fixture\n\nOld body');
  const builder = new IndexBuilder(store, docs);
  assert.equal((await builder.rebuild({ deferThreadIndexing: true })).docsIndexed, 1);
  assert.equal((await builder.rebuild()).docsSkipped, 1);
  const before = store.getDb().prepare('SELECT passage_id,content,created_at FROM evidence_passages').all();
  renameSync(docs, `${docs}-away`);
  await assert.rejects(builder.rebuild({ force: true }), /ENOENT/);
  assert.deepEqual(store.getDb().prepare('SELECT passage_id,content,created_at FROM evidence_passages').all(), before);
  renameSync(`${docs}-away`, docs);
  writeFileSync(path, '---\nfeature_ids: [F001]\n---\n# Fixture\n\nNew body');
  await builder.incrementalUpdate([path]);
  assert.ok((await store.search('New body', { depth: 'raw' })).some((item) => item.anchor === 'F001'));
  assert.equal((await builder.rebuild({ force: true })).docsIndexed, 1);
});
test('overlapping force rebuilds and incremental edits serialize their indexing work', async (t) => {
  const { docs, store } = await fixture(t);
  let active = 0;
  let maximum = 0;
  const builder = new IndexBuilder(store, docs, undefined, undefined, async () => {
    active++;
    maximum = Math.max(maximum, active);
    await pause(20);
    active--;
    return [];
  });
  await Promise.all([
    builder.rebuild({ force: true }),
    builder.rebuild({ force: true }),
    builder.incrementalUpdate([]),
  ]);
  assert.equal(maximum, 1);
});
test(
  'online history indexing yields between message batches while same-DB ledger writes proceed',
  { timeout: 30_000 },
  async (t) => {
    const { docs, store } = await fixture(t);
    const messages = Array.from({ length: 2000 }, (_, i) => ({
      id: `m-${i}`,
      threadId: 'fixture',
      content: `message ${i} ${'common text '.repeat(1000)}`,
      timestamp: Date.UTC(2026, 0, 1) + i,
    }));
    const builder = new IndexBuilder(
      store,
      docs,
      undefined,
      undefined,
      () => [{ id: 'fixture', title: 'Fixture', participants: [], lastActiveAt: Date.now() }],
      () => messages,
    );
    const ledger = new RunLedger(store.getDb());
    const gaps = [];
    const writes = [];
    let previous = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      gaps.push(now - previous);
      previous = now;
      const started = performance.now();
      ledger.record({
        task_id: 'index-fixture',
        subject_key: 'live',
        outcome: 'delivered',
        signal_summary: null,
        duration_ms: 0,
        started_at: Date.now(),
        assigned_cat_id: null,
      });
      writes.push(performance.now() - started);
    }, 5);
    try {
      await builder.rebuild({ force: true });
    } finally {
      clearInterval(timer);
    }
    assert.equal(
      store.getDb().prepare("SELECT count(*) AS n FROM evidence_passages WHERE passage_id LIKE 'msg-%'").get().n,
      2000,
    );
    assert.ok(gaps.length > 10);
    assert.ok(Math.max(...gaps) < 250, `max event loop gap ${Math.max(...gaps)}ms`);
    assert.ok(Math.max(...writes) < 100, `writer wait ${Math.max(...writes)}ms`);
    t.diagnostic(
      JSON.stringify({
        messages: 2000,
        turns: gaps.length,
        maxGapMs: Math.max(...gaps),
        maxWriterMs: Math.max(...writes),
      }),
    );
  },
);
