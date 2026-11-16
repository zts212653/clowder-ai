import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { setImmediate as yieldToIo } from 'node:timers/promises';
import * as sqliteVec from 'sqlite-vec';
import { IndexBuilder } from '../../src/domains/memory/IndexBuilder.js';
import type { IEmbeddingService, MessageRecallSuppressionLease } from '../../src/domains/memory/interfaces.js';
import { PassageVectorStore, passageVectorKey } from '../../src/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../src/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../src/domains/memory/schema.js';
import { VectorStore } from '../../src/domains/memory/VectorStore.js';

async function fixture(t: TestContext) {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const parent = (anchor = 'parent') =>
    store.upsert([{ anchor, kind: 'thread', status: 'active', title: 'Fixture', updatedAt: '2026-11-13' }]);
  await parent();
  const put = (id: string, content = id, anchor = 'parent') =>
    db
      .prepare('INSERT OR REPLACE INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)')
      .run(anchor, id, content, '2026-11-13T00:00:00Z');
  const encoded: string[] = [];
  const model = { modelId: 'warmup-fixture', modelRev: '1', dim: 4 };
  const embedding: IEmbeddingService = {
    load: async () => {},
    dispose: () => {},
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    getModelInfo: () => model,
    embed: async (texts) => {
      encoded.push(...texts);
      return texts.map(() => new Float32Array([1, 0, 0, 0]));
    },
  };
  const passages = new PassageVectorStore(db, 4);
  const deps = { embedding, vectorStore: new VectorStore(db, 4), passageVectorStore: passages };
  const builder = new IndexBuilder(store, '/unused-warmup-progress-fixture', deps);
  let scanned = 0;
  const existingKeys = passages.existingKeys.bind(passages);
  passages.existingKeys = (keys) => {
    scanned += keys.length;
    return existingKeys(keys);
  };
  return { store, db, parent, put, encoded, model, embedding, passages, deps, builder, scanned: () => scanned };
}

async function warmup(builder: IndexBuilder) {
  builder.startPassageEmbeddingWarmup();
  await yieldToIo();
  while (builder.isPassageWarmupActive()) await yieldToIo();
}

for (const reason of ['orphan', 'suppressed']) {
  test(`ineligible ${reason} is never encoded repeatedly and recovers when eligible`, async (t) => {
    const f = await fixture(t);
    const anchor = reason === 'orphan' ? 'missing-parent' : 'thread-fixture';
    const passageId = 'msg-blocked';
    if (reason === 'suppressed') await f.parent(anchor);
    f.put(passageId, 'blocked body', anchor);
    let lease: MessageRecallSuppressionLease | undefined;
    if (reason === 'suppressed') {
      lease = await f.builder.suppressMessagePassage('fixture', 'blocked');
      // A stale producer can leave a body behind the canonical recall guard.
      f.put(passageId, 'blocked body', anchor);
    }
    await warmup(f.builder);
    await warmup(f.builder);
    assert.deepEqual(f.encoded, [], 'ineligible source bodies must not reach the encoder');
    assert.equal(f.passages.count(), 0);
    if (reason === 'orphan') await f.parent(anchor);
    else {
      assert.ok(lease);
      assert.equal(await f.builder.releaseMessagePassageSuppression(lease), true);
    }
    await warmup(f.builder);
    assert.deepEqual(
      f.encoded.filter((body) => body === 'blocked body'),
      ['blocked body'],
    );
    assert.equal(f.passages.count(), 1);
  });
}

test('unchanged successful warmup skips metadata pages; new sources still get vectors', async (t) => {
  const f = await fixture(t);
  f.put('first');
  await warmup(f.builder);
  const scanned = f.scanned();
  await warmup(f.builder);
  assert.equal(f.scanned(), scanned, 'an idle retry must not walk the same corpus again');
  f.put('second');
  await warmup(f.builder);
  assert.deepEqual(f.encoded, ['first', 'second']);
  assert.equal(f.passages.count(), 2);
});

test('partial encoder failure recovers without a new source mutation', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 20; i++) f.put(`p${i}`);
  const embed = f.embedding.embed;
  let calls = 0;
  f.embedding.embed = async (texts, options) => {
    if (++calls === 2) throw new Error('one transient provider failure');
    return embed(texts, options);
  };
  await warmup(f.builder);
  assert.equal(f.passages.count(), 8);
  await warmup(f.builder);
  assert.equal(f.passages.count(), 20);
  assert.equal(f.encoded.length, 20, 'successful vectors must not be recomputed during recovery');
});

test('source changes during encoding prevent completion and are retried', async (t) => {
  const f = await fixture(t);
  f.put('changing', 'before');
  const embed = f.embedding.embed;
  let changed = false;
  f.embedding.embed = async (texts, options) => {
    if (!changed) {
      changed = true;
      f.db.prepare('UPDATE evidence_passages SET content=? WHERE passage_id=?').run('after', 'changing');
    }
    return embed(texts, options);
  };
  await warmup(f.builder);
  assert.equal(f.passages.count(), 0);
  await warmup(f.builder);
  assert.deepEqual(f.encoded, ['before', 'after']);
  assert.equal(f.passages.count(), 1);
});

test('same-sized canonical replacement and physical clear invalidate completion', async (t) => {
  const f = await fixture(t);
  f.put('one');
  await warmup(f.builder);
  f.db.prepare('DELETE FROM evidence_passages WHERE passage_id=?').run('one');
  f.put('two');
  f.passages.upsert(passageVectorKey('parent', 'two'), new Float32Array([1, 0, 0, 0]));
  const beforeReplacement = f.scanned();
  await warmup(f.builder);
  assert.ok(f.scanned() > beforeReplacement, 'same count does not certify unchanged sources');
  const beforeClear = f.scanned();
  f.passages.clearAll();
  await warmup(f.builder);
  assert.ok(f.scanned() > beforeClear);
  assert.deepEqual(f.encoded, ['one', 'two']);
  assert.equal(f.passages.count(), 1);
});

test('dependency rebinding and model identity changes invalidate completion', async (t) => {
  const f = await fixture(t);
  f.put('one');
  await warmup(f.builder);
  let previous = f.scanned();
  f.builder.setEmbedDeps({ ...f.deps });
  await warmup(f.builder);
  assert.ok(f.scanned() > previous);
  previous = f.scanned();
  f.model.modelRev = '2';
  await warmup(f.builder);
  assert.ok(f.scanned() > previous);
});

test('unavailable completion evidence falls back to ordinary backfill', async (t) => {
  const f = await fixture(t);
  f.put('one');
  t.mock.method(f.db, 'pragma', () => {
    throw new Error('completion observation unavailable');
  });
  await warmup(f.builder);
  assert.deepEqual(f.encoded, ['one']);
  const previous = f.scanned();
  await warmup(f.builder);
  assert.ok(f.scanned() > previous, 'uncertainty must not suppress needed work');
});

test('a retired in-flight run cannot certify a newly bound dependency', async (t) => {
  const f = await fixture(t);
  f.put('one');
  let release: (() => void) | undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const embed = f.embedding.embed;
  f.embedding.embed = async (texts, options) => {
    await held;
    return embed(texts, options);
  };
  f.builder.startPassageEmbeddingWarmup();
  await yieldToIo();
  while (f.scanned() === 0) await yieldToIo();
  f.builder.setEmbedDeps({ ...f.deps });
  assert.ok(release);
  release();
  while (f.builder.isPassageWarmupActive()) await yieldToIo();
  assert.equal(f.passages.count(), 0);
  await warmup(f.builder);
  assert.equal(f.passages.count(), 1, 'the next existing recovery tick must use the new binding');
});
