import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { literalTermCoverage } from '../../dist/domains/memory/literal-term-coverage.js';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

// The live mixed-language query lost its literal source before the candidate
// cap, then hybrid fusion could let unrelated NN-only rows win it back out.
// Tiny real SQLite/native-vector pools reproduce both boundaries without live data.
describe('mixed-language message relevance', () => {
  let store;
  let vectors;
  const options = { visibleThreadIds: ['a-noise', 'z-source'], mode: 'lexical', sort: 'relevance', candidateLimit: 2 };
  const add = (thread, id, content, date = '2026-09-01T00:00:00.000Z') =>
    store
      .getDb()
      .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)')
      .run(`thread-${thread}`, `msg-${id}`, content, date);

  beforeEach(async () => {
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert(
      ['a-noise', 'z-source', 'private'].map((id) => ({
        anchor: `thread-${id}`,
        kind: 'thread',
        status: 'active',
        title: id,
        updatedAt: '2026-10-01T00:00:00Z',
      })),
    );
  });
  afterEach(() => store.close());

  it('preserves distinct substring coverage for overlaps, suffixes, repeats and UTF-16 input', () => {
    const words = ['a', 'ba', 'aba', 'baba', 'a', '起名', '名', '猫🐾', '🐾', '\ud83d', '\0名'];
    const count = literalTermCoverage(words);
    for (const text of ['bababa 起名 起名', '猫🐾\0名', 'absent', '', 'a'.repeat(2000)]) {
      assert.equal(count(text), [...new Set(words)].filter((word) => text.includes(word)).length);
    }
    for (let size = 0; size <= 6; size++) {
      const subset = words.slice(0, size);
      for (const text of ['bababa 起名', '猫🐾\0名', 'absent', '']) {
        assert.equal(
          literalTermCoverage(subset)(text),
          [...new Set(subset)].filter((word) => text.includes(word)).length,
        );
      }
    }
    const all = Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + i));
    assert.equal(literalTermCoverage(all)(all.join('、')), 1000, 'no query terms are discarded');
  });

  it('rebinds connection-local matching to each query and preserves CJK-only eligibility', async () => {
    add('a-noise', 'first', 'Mira 起名的记载');
    add('z-source', 'second', 'Nova 改名的记载');
    const first = await store.searchMessagePassages('Mira 起名', options);
    const second = await store.searchMessagePassages('Nova 改名', options);
    assert.deepEqual(
      first.passages.map((p) => p.messageId),
      ['first'],
    );
    assert.deepEqual(
      second.passages.map((p) => p.messageId),
      ['second'],
    );
    const partial = await store.searchMessagePassages('Absent 改名', options);
    assert.deepEqual(
      partial.passages.map((p) => p.messageId),
      ['second'],
    );
  });

  it('ranks full query evidence before CJK-only noise before applying the bounded pool', async () => {
    for (let i = 0; i < 4; i++) add('a-noise', `noise-${i}`, '这是另一只猫起名的讨论。');
    add('z-source', 'source', 'Mira 起名的原始故事在这里。');
    const result = await store.searchMessagePassages('mira 起名', options);
    assert.equal(result.passages[0]?.messageId, 'source');
    assert.equal(result.meta.candidateLimit, 2);
  });

  it('does not let FTS token boundaries or repetitive retellings bury a concise literal source', async () => {
    add('a-noise', 'retold', 'Mira 起名 '.repeat(80));
    add('z-source', 'source', 'Mira 起名的原始故事在这里。');
    const result = await store.searchMessagePassages('Mira 起名', options);
    assert.equal(result.passages[0]?.messageId, 'source');
    assert.equal(result.passages.length, 2, 'overlapping FTS and literal hits must not consume the pool twice');
  });

  it('does not privilege spaced CJK query echoes over a concise unspaced original', async () => {
    add('a-noise', 'echo', '检索验收的 query 是“归属 称谓”，保持原参数和来源。'.repeat(30));
    add('z-source', 'source', '请按归属称谓来选择合适的表达。');
    const lexical = await store.searchMessagePassages('归属 称谓', { ...options, candidateLimit: 1 });
    assert.equal(lexical.passages[0]?.messageId, 'source');

    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 3);
    ensurePassageVectorTable(db, 3);
    vectors = new PassageVectorStore(db, 3);
    store.setEmbedDeps({
      mode: 'on',
      vectorStore: new VectorStore(db, 3),
      passageVectorStore: vectors,
      embedding: {
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        embed: async () => [new Float32Array([1, 0, 0])],
        getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 3 }),
      },
    });
    vectors.upsert(passageVectorKey('thread-a-noise', 'msg-echo'), new Float32Array([1, 0, 0]));
    vectors.upsert(passageVectorKey('thread-z-source', 'msg-source'), new Float32Array([0, 1, 0]));
    const hybrid = await store.searchMessagePassages('归属 称谓', {
      ...options,
      mode: 'hybrid',
      candidateLimit: 1,
    });
    assert.equal(hybrid.passages[0]?.messageId, 'source');
    assert.equal(hybrid.meta.degraded, false);
  });

  it('keeps exact literal evidence through hybrid fusion even when NN has a closer unrelated row', async () => {
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 3);
    ensurePassageVectorTable(db, 3);
    vectors = new PassageVectorStore(db, 3);
    store.setEmbedDeps({
      mode: 'on',
      vectorStore: new VectorStore(db, 3),
      passageVectorStore: vectors,
      embedding: {
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        embed: async () => [new Float32Array([1, 0, 0])],
        getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 3 }),
      },
    });
    add('a-noise', 'near', 'Unrelated scheduling discussion');
    add('z-source', 'source', 'Mira 起名的原始故事在这里。');
    add('private', 'secret', 'Mira 起名');
    vectors.upsert(passageVectorKey('thread-a-noise', 'msg-near'), new Float32Array([1, 0, 0]));
    vectors.upsert(passageVectorKey('thread-z-source', 'msg-source'), new Float32Array([0, 1, 0]));
    const result = await store.searchMessagePassages('Mira 起名', { ...options, mode: 'hybrid', candidateLimit: 1 });
    assert.equal(result.passages[0]?.messageId, 'source');
    assert.equal(result.meta.degraded, false);
    assert.equal(result.meta.candidateLimit, 1);
  });

  it('keeps complete non-adjacent query evidence ahead of unrelated semantic neighbors', async () => {
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 3);
    ensurePassageVectorTable(db, 3);
    vectors = new PassageVectorStore(db, 3);
    store.setEmbedDeps({
      mode: 'on',
      vectorStore: new VectorStore(db, 3),
      passageVectorStore: vectors,
      embedding: {
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        embed: async () => [new Float32Array([1, 0, 0])],
        getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 3 }),
      },
    });
    add('a-noise', 'near', 'hello');
    add('a-noise', 'partial', '只有归属这一半的记录');
    add('z-source', 'source', '称谓应该按自己的归属与关系选择。');
    vectors.upsert(passageVectorKey('thread-a-noise', 'msg-near'), new Float32Array([1, 0, 0]));
    vectors.upsert(passageVectorKey('thread-z-source', 'msg-source'), new Float32Array([0, 1, 0]));
    const result = await store.searchMessagePassages('归属 称谓', { ...options, mode: 'hybrid', candidateLimit: 1 });
    assert.equal(result.passages[0]?.messageId, 'source');
    assert.equal(result.meta.degraded, false);
    const expanded = await store.searchMessagePassages('归属 称谓', { ...options, mode: 'hybrid', candidateLimit: 3 });
    assert.ok(
      expanded.passages.some((p) => p.messageId === 'near'),
      'semantic discovery retains remaining pool budget',
    );
  });

  it('retains chronological ordering and exact-source/date admission independently of relevance', async () => {
    add('a-noise', 'old', '较长的 Mira 起名 旧记录。', '2026-08-01T00:00:00Z');
    add('z-source', 'new', 'Mira 起名', '2026-09-01T00:00:00Z');
    add('private', 'secret', 'Mira 起名', '2026-07-01T00:00:00Z');
    const time = await store.searchMessagePassages('Mira 起名', { ...options, sort: 'time' });
    assert.deepEqual(
      time.passages.map((p) => p.messageId),
      ['old', 'new'],
    );
    const excluded = await store.searchMessagePassages('Mira 起名', {
      ...options,
      excludeSource: { threadId: 'z-source', messageId: 'new' },
      dateFrom: '2026-08-01',
    });
    assert.deepEqual(
      excluded.passages.map((p) => p.messageId),
      ['old'],
    );
  });

  it('treats query punctuation as bound data and keeps foreign threads outside literal ranking', async () => {
    const query = "Mira 起名'); DROP TABLE evidence_passages; --";
    add('z-source', 'source', query);
    add('private', 'secret', query);
    const result = await store.searchMessagePassages(query, options);
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['source'],
    );
    assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM evidence_passages').get().n, 2);
  });

  it('accepts a valid 1999-character CJK query without creating a deep SQL expression', async () => {
    const query = Array.from({ length: 1000 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join(' ');
    add('z-source', 'source', '一');
    const result = await store.searchMessagePassages(query, options);
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['source'],
    );
  });
});
