import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vec from 'sqlite-vec';
import { safeNativeReadProgress } from '../../dist/domains/memory/message-read-progress-native.js';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

test('real worker preserves native/CJK evidence through its final private projection and next job', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-reader-evidence-'));
  const store = new SqliteEvidenceStore(join(root, 'evidence.sqlite'));
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  await store.upsert([
    { anchor: 'thread-fixture', kind: 'thread', status: 'active', title: 'Neutral', updatedAt: '2026-01-01' },
  ]);
  const db = store.getDb();
  db.prepare(
    "INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES('thread-fixture','msg-target','合成证据 private-body-canary','2026-01-01')",
  ).run();
  vec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const vectors = new PassageVectorStore(db, 4);
  vectors.upsert(passageVectorKey('thread-fixture', 'msg-target'), new Float32Array([1, 0, 0, 0]));
  const metadata = new VectorStore(db, 4);
  const model = { modelId: 'native-evidence-fixture', modelRev: '1', dim: 4 };
  metadata.initMeta(model);
  let providerCalls = 0;
  store.setEmbedDeps({
    mode: 'on',
    vectorStore: metadata,
    passageVectorStore: vectors,
    embedding: {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      isReady: () => true,
      getModelInfo: () => model,
      embed: async (texts) => {
        providerCalls++;
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      },
    },
  });
  const frames = [];
  const result = await store.searchMessagePassages('合成证据', {
    mode: 'hybrid',
    sort: 'relevance',
    visibleThreadIds: ['fixture'],
    onReadSnapshot: (s) => frames.push(s),
  });
  assert.deepEqual(
    result.passages.map((p) => p.messageId),
    ['target'],
  );
  assert.deepEqual(Object.keys(result).sort(), ['meta', 'passages']);
  assert.equal(providerCalls, 1, 'actual query RPC must occur');
  const final = frames.at(-1);
  assert.equal(final.outcome, 'fulfilled');
  assert.ok(final.cjk?.resourceDelta, 'paired CJK process counters lost over IPC');
  assert.equal(final.nativeVectorRead?.event, 'sql-finish');
  if (process.platform === 'darwin') {
    assert.equal(final.readWindow?.active, true);
    assert.equal(final.readWindow.cleanup, true);
    assert.ok(final.readWindow.counters, 'completed counters must survive result IPC, including legitimate zero reads');
    assert.ok(Number.isSafeInteger(final.readWindow.counters.mapCalls));
    const pending = frames.find((s) => s.nativeVectorRead?.event === 'sql-start');
    assert.equal(pending.readWindow.active, true);
    assert.equal(pending.readWindow.counters, null, 'in-flight or killed SQL has no completed counters');
  }
  assert.ok(frames.length <= 10, 'window evidence must reuse existing events');
  const projected = safeNativeReadProgress({
    ...final,
    readWindow: final.readWindow && {
      ...final.readWindow,
      extra: 'private-path-canary',
      counters: { ...final.readWindow.counters, extra: 'private-vector-canary' },
    },
  });
  assert.deepEqual(projected.readWindow, final.readWindow);
  assert.deepEqual(projected.cjk.resourceDelta, final.cjk.resourceDelta);
  assert.doesNotMatch(JSON.stringify(projected), /private-|modelId|databasePath|SELECT|bindings/);
  const next = [];
  await store.searchMessagePassages('合成证据', {
    mode: 'lexical',
    sort: 'relevance',
    visibleThreadIds: ['fixture'],
    onReadSnapshot: (s) => next.push(s),
  });
  assert.equal(next.at(-1).nativeVectorRead, null);
  assert.equal(next.at(-1).readWindow.active, null);
  assert.equal(next.at(-1).readWindow.counters, null, 'a later job cannot inherit the previous window counts');
});
