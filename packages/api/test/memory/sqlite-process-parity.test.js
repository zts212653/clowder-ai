import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { EntityConflictStaleError, EntitySurfaceConflictError } from '../../dist/domains/memory/EntityRegistry.js';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { lookupShadowRanking, SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

const entity = {
  entityId: 'person:test',
  type: 'person',
  canonicalName: 'Test Person',
  aliases: ['读者甲'],
  provenance: [{ source: 'fixture' }],
  updatedAt: '2026-01-01',
};
async function makeStore(t, memory = false) {
  const root = mkdtempSync(join(tmpdir(), 'memory-parity-'));
  const store = new SqliteEvidenceStore(memory ? ':memory:' : join(root, 'evidence.sqlite'), undefined, {
    sourceRoot: '/fixture/docs',
  });
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}
const items = [
  {
    anchor: 'F001',
    kind: 'feature',
    status: 'active',
    title: '记忆系统：读者甲 common',
    summary: '共同记忆 substring词语',
    keywords: ['中文', 'memory'],
    sourcePath: 'features/F001.md',
    updatedAt: '2026-02-01',
    authority: 'observed',
  },
  {
    anchor: 'F002',
    kind: 'feature',
    status: 'superseded',
    title: 'Old common memory',
    summary: '读者甲',
    updatedAt: '2026-01-01',
    supersededBy: 'F001',
    authority: 'validated',
  },
  {
    anchor: 'ADR-001',
    kind: 'decision',
    status: 'active',
    title: 'Common contracts',
    summary: 'memory',
    updatedAt: '2026-01-03',
    authority: 'constitutional',
  },
  { anchor: 'thread-fixture', kind: 'thread', status: 'active', title: 'Fixture common', updatedAt: '2026-01-02' },
];
async function populate(store) {
  await store.upsert(items.map((item) => ({ ...item })));
  store.getDb().prepare('UPDATE evidence_docs SET first_indexed_at = 1767225600000').run();
  const insert = store
    .getDb()
    .prepare(
      `INSERT INTO evidence_passages (doc_anchor,passage_id,content,speaker,position,created_at) VALUES (?,?,?,?,?,?)`,
    );
  for (let i = 0; i < 12; i++)
    insert.run(
      'thread-fixture',
      `msg-${i}`,
      `${i % 2 ? '读者甲 common ' : 'context '}${'memory '.repeat(i + 1)}`,
      'user',
      i,
      `2026-01-${String(i + 1).padStart(2, '0')}`,
    );
  await store.upsertEntities([entity]);
}
test('disk process preserves lexical, CJK, entity, scope, date, raw context and shadow ranking', async (t) => {
  const disk = await makeStore(t);
  const local = await makeStore(t, true);
  await populate(disk);
  await populate(local);
  const queries = ['common', 'F001', 'substring', '读者甲', '记忆 中文', 'no-result-xyz'];
  const options = [
    { limit: 3 },
    { limit: 4, scope: 'docs' },
    { limit: 4, scope: 'threads', depth: 'raw', contextWindow: 1 },
    { limit: 4, depth: 'raw', dateFrom: '2026-01-05', dateTo: '2026-01-09' },
  ];
  for (const query of queries)
    for (const opts of options) {
      assert.deepEqual(
        await disk.searchWithMeta(query, opts),
        await local.searchWithMeta(query, opts),
        `${query} ${JSON.stringify(opts)}`,
      );
    }
  for (const options of [
    { visibleThreadIds: ['fixture'], mode: 'lexical', sort: 'time', candidateLimit: 5 },
    {
      visibleThreadIds: ['fixture'],
      mode: 'lexical',
      sort: 'relevance',
      dateFrom: '2026-01-05',
      excludeSource: { threadId: 'fixture', messageId: '3' },
    },
    { visibleThreadIds: [], mode: 'lexical' },
  ])
    assert.deepEqual(
      await disk.searchMessagePassages('common', options),
      await local.searchMessagePassages('common', options),
    );
  const prior = process.env.F200_CONSUMPTION_RERANK;
  const authority = process.env.F163_AUTHORITY_BOOST;
  t.after(() => {
    if (prior === undefined) delete process.env.F200_CONSUMPTION_RERANK;
    else process.env.F200_CONSUMPTION_RERANK = prior;
    if (authority === undefined) delete process.env.F163_AUTHORITY_BOOST;
    else process.env.F163_AUTHORITY_BOOST = authority;
  });
  process.env.F200_CONSUMPTION_RERANK = 'shadow';
  process.env.F163_AUTHORITY_BOOST = 'on';
  const actual = await disk.search('common', { limit: 4 });
  const actualShadow = lookupShadowRanking(actual.map((item) => item.anchor));
  const expected = await local.search('common', { limit: 4 });
  const expectedShadow = lookupShadowRanking(expected.map((item) => item.anchor));
  assert.deepEqual(actual, expected);
  assert.deepEqual(actualShadow, expectedShadow);
  assert.ok(actualShadow);
});
test('semantic and hybrid embedding bridge preserves query vectors and passage ranking', async (t) => {
  const stores = [await makeStore(t), await makeStore(t, true)];
  for (const store of stores) {
    await populate(store);
    sqliteVec.load(store.getDb());
    ensureVectorTable(store.getDb(), 2);
    ensurePassageVectorTable(store.getDb(), 2);
    const vectorStore = new VectorStore(store.getDb(), 2);
    const passageVectorStore = new PassageVectorStore(store.getDb(), 2);
    vectorStore.upsert('F001', new Float32Array([1, 0]));
    vectorStore.upsert('ADR-001', new Float32Array([0, 1]));
    passageVectorStore.upsert(passageVectorKey('thread-fixture', 'msg-3'), new Float32Array([1, 0]));
    const embedding = {
      async load() {},
      async reprobeIfNeeded() {},
      async embed(texts) {
        return texts.map(() => new Float32Array([1, 0]));
      },
      isReady: () => true,
      getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 2 }),
      dispose() {},
    };
    store.setEmbedDeps({ embedding, vectorStore, passageVectorStore, mode: 'on' });
  }
  for (const mode of ['semantic', 'hybrid'])
    for (const depth of ['summary', 'raw']) {
      assert.deepEqual(
        await stores[0].searchWithMeta('memory', { mode, depth, limit: 3 }),
        await stores[1].searchWithMeta('memory', { mode, depth, limit: 3 }),
      );
    }
});
test('entity rename, alias deletion, rollback and conflict errors retain atomic revision semantics', async (t) => {
  const store = await makeStore(t);
  await populate(store);
  const changed = { ...entity, aliases: ['different'], updatedAt: '2026-02-02' };
  const before = store.getDb().prepare('SELECT count(*) AS n FROM entity_mentions').get();
  store
    .getDb()
    .exec(
      `CREATE TRIGGER fail_mentions BEFORE INSERT ON entity_mention_entity_heads BEGIN SELECT RAISE(ABORT, 'projection failed'); END`,
    );
  await assert.rejects(store.upsertEntities([{ ...entity, aliases: ['memory'] }]), /projection failed/);
  assert.deepEqual((await store.getEntity(entity.entityId))?.aliases, ['读者甲']);
  assert.deepEqual(store.getDb().prepare('SELECT count(*) AS n FROM entity_mentions').get(), before);
  store.getDb().exec('DROP TRIGGER fail_mentions');
  const incoming = { ...entity, entityId: 'person:other', canonicalName: 'Other' };
  await assert.rejects(
    store.upsertEntities([incoming], { source: 'proposal-approval', conflictPolicy: 'reject-conflict' }),
    EntitySurfaceConflictError,
  );
  const conflict = await store.inspectEntityConflict(changed);
  assert.ok(conflict);
  await store.upsertEntities([changed]);
  assert.equal(
    store.getDb().prepare(`SELECT count(*) AS n FROM entity_mentions WHERE entity_id=?`).get(entity.entityId).n,
    0,
  );
  await assert.rejects(
    store.resolveEntityConflict(
      changed,
      { action: conflict.allowedActions[0], fingerprint: conflict.fingerprint },
      { source: 'proposal-approval' },
    ),
    EntityConflictStaleError,
  );
  await store.upsertEntities([{ ...entity, aliases: [], updatedAt: '2026-02-03' }]);
  assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM entity_mentions').get().n, 0);
});
