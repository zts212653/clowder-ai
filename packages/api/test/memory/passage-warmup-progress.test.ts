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
import { prepareGenerationInvalidationConnection } from '../../src/domains/memory/vector-generation-invalidation.js';

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

// 2026-11-16, boot92: 202 warmups in 3 h 50 min, each walking all 562,800 passages again; 153 of the
// 199 that finished embedded nothing. Every chat write moved the source epoch, which was the whole
// "nothing changed" certificate. Passage ids only grow and bodies are never rewritten in place, so
// after one complete walk a missing vector can only be a newer row, or an older row whose vector
// went away while the row stayed.

test('a write after a completed warmup costs a look at the new rows, not the whole corpus again', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 40; i++) f.put(`p${i}`);
  await warmup(f.builder);
  assert.equal(f.passages.count(), 40);
  for (let round = 0; round < 5; round++) {
    const before = f.scanned();
    f.put(`late-${round}`); // what a chat turn does: one more passage, and the source epoch moves
    await warmup(f.builder);
    assert.equal(f.scanned() - before, 1, 'only the new row is checked');
  }
  assert.equal(f.passages.count(), 45);
  assert.equal(f.encoded.length, 45);
});

test('replaced passages are new rows too: their vectors left with the old rows', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 40; i++) f.put(`p${i}`);
  await warmup(f.builder);
  // A document is re-indexed: three passages are deleted with their vectors and three are inserted.
  for (const id of ['p0', 'p1', 'p2']) {
    f.db.prepare('DELETE FROM evidence_passages WHERE passage_id=?').run(id);
    f.passages.delete(passageVectorKey('parent', id));
  }
  for (const id of ['r0', 'r1', 'r2']) f.put(id);
  const before = f.scanned();
  await warmup(f.builder);
  assert.equal(f.scanned() - before, 3, 'fewer vectors is explained by fewer rows');
  assert.equal(f.passages.count(), 40);
});

test('a vector that goes away while its row stays is found at once', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 40; i++) f.put(`p${i}`);
  await warmup(f.builder);
  f.put('late'); // an unrelated write, so the warmup is not skipped outright
  f.passages.delete(passageVectorKey('parent', 'p7')); // e.g. the parent's visibility changed
  const before = f.scanned();
  await warmup(f.builder);
  assert.ok(f.scanned() - before >= 41, 'vectors are missing that no deleted row accounts for: walk everything');
  assert.equal(f.passages.count(), 41);
  assert.deepEqual(f.encoded.slice(-2).sort(), ['late', 'p7']);
});

test('the whole corpus is walked again after ten minutes, and not before', async (t) => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T23:00:00Z') });
  for (let i = 0; i < 40; i++) f.put(`p${i}`);
  await warmup(f.builder);
  const walk = async (id: string) => {
    const before = f.scanned();
    f.put(id);
    await warmup(f.builder);
    return f.scanned() - before;
  };
  t.mock.timers.tick(9 * 60_000);
  assert.equal(await walk('late-1'), 1);
  t.mock.timers.tick(60_000);
  assert.equal(await walk('late-2'), 42, 'the backstop for what no cheap signal shows');
  assert.equal(await walk('late-3'), 1, 'and the next ten minutes start from there');
});

test('a warmup that did not finish cleanly does not move the starting point', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 40; i++) f.put(`p${i}`);
  await warmup(f.builder);
  const embed = f.embedding.embed;
  let failures = 1;
  f.embedding.embed = async (texts, options) => {
    if (failures-- > 0) throw new Error('one transient provider failure');
    return embed(texts, options);
  };
  f.put('late-1');
  await warmup(f.builder); // the provider fails: late-1 stays without a vector
  assert.equal(f.passages.count(), 40);
  f.put('late-2');
  await warmup(f.builder);
  assert.equal(f.passages.count(), 42, 'late-1 is still inside the range the next warmup looks at');
});

test('a certificate earned by looking only at new rows expires with the full-walk interval', async (t) => {
  // Review probe for #7194: one vector is lost below the watermark while another row arrives already
  // embedded, so the counts cancel out. Then nothing is written any more.
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T23:00:00Z') });
  f.put('old-a');
  f.put('old-b');
  await warmup(f.builder);
  f.passages.delete(passageVectorKey('parent', 'old-a'));
  f.put('new-c');
  f.passages.upsert(passageVectorKey('parent', 'new-c'), new Float32Array([1, 0, 0, 0]));
  await warmup(f.builder); // looks at new-c only: two vectors, as before
  assert.equal(f.passages.count(), 2);
  let scanned = f.scanned();
  await warmup(f.builder);
  assert.equal(f.scanned(), scanned, 'unchanged within the interval: skipped');

  t.mock.timers.tick(10 * 60_000 + 1);
  await warmup(f.builder);
  assert.equal(f.passages.count(), 3, 'the backstop runs although nothing was written since');
  assert.deepEqual(f.encoded, ['old-a', 'old-b', 'old-a']);
  scanned = f.scanned();
  t.mock.timers.tick(10 * 60_000 + 1);
  await warmup(f.builder);
  assert.equal(f.scanned(), scanned, 'unchanged since a complete walk: skipped for as long as that holds');
});

test('a message rewritten in place keeps its row, loses its vector, and is embedded again at once', async (t) => {
  // indexPassages upserts thread messages ON CONFLICT DO UPDATE SET content: the row id stays.
  const f = await fixture(t);
  prepareGenerationInvalidationConnection(f.db); // the canonical writer's native triggers
  for (let i = 0; i < 40; i++) f.put(`p${i}`);
  await warmup(f.builder);
  const id = () => (f.db.prepare("SELECT id FROM evidence_passages WHERE passage_id='p7'").get() as { id: number }).id;
  const before = id();
  f.db
    .prepare(`INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES('parent','p7',?,?)
      ON CONFLICT(doc_anchor, passage_id) DO UPDATE SET content=excluded.content`)
    .run('edited body', '2026-11-13T00:00:00Z');
  assert.equal(id(), before, 'the same row');
  assert.equal(f.passages.count(), 39, 'its vector went with the old body');
  const scanned = f.scanned();
  await warmup(f.builder);
  assert.ok(f.scanned() - scanned >= 40, 'a vector is missing that no deleted row accounts for');
  assert.equal(f.passages.count(), 40);
  assert.equal(f.encoded.at(-1), 'edited body');
});
