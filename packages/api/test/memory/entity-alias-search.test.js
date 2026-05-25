import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

function createEmbedding(vector) {
  return {
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    embed: async () => [vector],
    getModelInfo: () => ({ modelId: 'test-entity-alias', modelRev: 'v1', dim: 3 }),
  };
}

describe('F209 entity alias search', () => {
  let store;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  async function seedYouEntity() {
    await store.upsertEntities([
      {
        entityId: 'person:landy',
        type: 'person',
        canonicalName: 'You',
        aliases: ['you', '铲屎官', 'CVO'],
        provenance: [{ source: 'F209 Phase B test', anchor: 'F209' }],
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);
  }

  it('finds doc evidence through deterministic alias expansion', async () => {
    await store.upsert([
      {
        anchor: 'F209-alias-doc',
        kind: 'feature',
        status: 'active',
        title: 'Entity alias design note',
        summary: '铲屎官要求中文称呼也指向同一个可检索实体门牌号。',
        keywords: ['memory', 'entity'],
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);
    await seedYouEntity();

    const results = await store.search('CVO', { scope: 'docs', limit: 5, explain: true });

    assert.equal(results[0].anchor, 'F209-alias-doc');
    assert.equal(results[0].matchReason, 'entity:person:landy');
    assert.equal(results[0].entityMatches?.[0]?.entityId, 'person:landy');
    assert.equal(results[0].entityMatches?.[0]?.type, 'person');
    assert.equal(results[0].entityMatches?.[0]?.surface, '铲屎官');
    assert.match(results[0].entityMatches?.[0]?.why ?? '', /CVO.*person:landy.*铲屎官/);
  });

  it('limits entity doc hits by distinct anchors instead of raw mention rows', async () => {
    await store.upsert([
      {
        anchor: 'entity-crowded-doc',
        kind: 'feature',
        status: 'active',
        title: 'Crowded entity doc',
        summary: '铲屎官 appears here and also in several passages.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
      {
        anchor: 'entity-second-doc',
        kind: 'feature',
        status: 'active',
        title: 'Second entity doc',
        summary: '铲屎官 appears in this separate anchor.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);
    const insertPassage = store.getDb().prepare(`
      INSERT INTO evidence_passages
      (doc_anchor, passage_id, content, speaker, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 3; index += 1) {
      insertPassage.run(
        'entity-crowded-doc',
        `msg-crowded-${index}`,
        `铲屎官 repeated mention ${index}`,
        'codex',
        index,
        `2026-05-22T01:0${index}:00Z`,
      );
    }
    await seedYouEntity();

    const results = await store.search('CVO', { scope: 'docs', limit: 2 });
    const anchors = results.map((result) => result.anchor);

    assert.equal(new Set(anchors).size, 2);
    assert.ok(anchors.includes('entity-crowded-doc'));
    assert.ok(anchors.includes('entity-second-doc'));
  });

  it('orders entity doc hits by evidence timestamp after a global mention refresh', async () => {
    await store.upsert([
      {
        anchor: 'a-old-entity-doc',
        kind: 'feature',
        status: 'active',
        title: 'Old entity doc',
        summary: '铲屎官 appears in older evidence.',
        updatedAt: '2026-05-20T00:00:00Z',
      },
      {
        anchor: 'z-new-entity-doc',
        kind: 'feature',
        status: 'active',
        title: 'New entity doc',
        summary: '铲屎官 appears in newer evidence.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);
    await seedYouEntity();

    const results = await store.search('CVO', { scope: 'docs', limit: 1 });

    assert.equal(results[0].anchor, 'z-new-entity-doc');
  });

  it('applies doc filters before capping entity mention anchors', async () => {
    await store.upsert([
      {
        anchor: 'entity-archived-crowded-doc',
        kind: 'feature',
        status: 'archived',
        title: 'Archived crowded entity doc',
        summary: '铲屎官 appears here but this doc is archived.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
      {
        anchor: 'entity-active-filtered-doc',
        kind: 'feature',
        status: 'active',
        title: 'Active filtered entity doc',
        summary: '铲屎官 appears in this active anchor.',
        updatedAt: '2026-05-21T00:00:00Z',
      },
    ]);
    const insertPassage = store.getDb().prepare(`
      INSERT INTO evidence_passages
      (doc_anchor, passage_id, content, speaker, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (let index = 0; index < 3; index += 1) {
      insertPassage.run(
        'entity-archived-crowded-doc',
        `msg-archived-${index}`,
        `铲屎官 archived repeated mention ${index}`,
        'codex',
        index,
        `2026-05-22T02:0${index}:00Z`,
      );
    }
    await seedYouEntity();

    const results = await store.search('CVO', { scope: 'docs', status: 'active', limit: 1 });

    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'entity-active-filtered-doc');
  });

  it('returns raw passage anchors for entity mention hits', async () => {
    await seedYouEntity();
    await store.upsert([
      {
        anchor: 'thread-thread_alias',
        kind: 'thread',
        status: 'active',
        title: 'Mixed memory discussion',
        summary: 'Thread with a Chinese-only entity mention.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    store
      .getDb()
      .prepare(
        `INSERT INTO evidence_passages
         (doc_anchor, passage_id, content, speaker, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'thread-thread_alias',
        'msg-entity',
        '铲屎官说 Phase B 要先把实体门牌号和 alias provenance 钉住。',
        'codex',
        0,
        '2026-05-22T01:00:00Z',
      );
    await store.refreshEntityMentions(['thread-thread_alias']);

    const results = await store.search('CVO', { depth: 'raw', scope: 'threads', limit: 5 });

    assert.equal(results[0].anchor, 'thread-thread_alias');
    assert.equal(results[0].passages?.[0]?.passageId, 'msg-entity');
    assert.equal(results[0].passages?.[0]?.messageId, 'entity');
    assert.match(results[0].passages?.[0]?.content ?? '', /铲屎官/);
    assert.equal(results[0].entityMatches?.[0]?.entityId, 'person:landy');
  });

  it('deduplicates entity raw passage hits before applying the mention pool limit', async () => {
    await store.upsertEntities([
      {
        entityId: 'person:landy',
        type: 'person',
        canonicalName: 'You',
        aliases: ['CVO'],
        provenance: [{ source: 'F209 Phase B test', anchor: 'F209' }],
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);
    await store.upsert([
      {
        anchor: 'thread-thread_entity_dedupe',
        kind: 'thread',
        status: 'active',
        title: 'Entity dedupe thread',
        summary: 'Thread with manually indexed entity mentions.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    const db = store.getDb();
    const insertPassage = db.prepare(`
      INSERT INTO evidence_passages
      (doc_anchor, passage_id, content, speaker, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertPassage.run(
      'thread-thread_entity_dedupe',
      'msg-crowded',
      'The same passage contains many registered surfaces for one entity.',
      'codex',
      0,
      '2026-05-22T01:00:00Z',
    );
    insertPassage.run(
      'thread-thread_entity_dedupe',
      'msg-rare',
      'A later valid passage should survive entity mention dedupe.',
      'codex',
      1,
      '2026-05-22T01:01:00Z',
    );

    const insertMention = db.prepare(`
      INSERT INTO entity_mentions
      (entity_id, doc_anchor, passage_id, surface, surface_norm, source, provenance_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const provenanceJson = JSON.stringify([{ source: 'manual dedupe fixture' }]);
    for (let index = 0; index < 25; index += 1) {
      const surface = `crowded-alias-${index}`;
      insertMention.run(
        'person:landy',
        'thread-thread_entity_dedupe',
        'msg-crowded',
        surface,
        surface,
        'passage',
        provenanceJson,
        `2026-05-22T02:${String(index).padStart(2, '0')}:00Z`,
      );
    }
    insertMention.run(
      'person:landy',
      'thread-thread_entity_dedupe',
      'msg-rare',
      'rare-alias',
      'rare-alias',
      'passage',
      provenanceJson,
      '2026-05-22T01:00:00Z',
    );

    const results = await store.search('CVO', {
      depth: 'raw',
      scope: 'threads',
      threadId: 'thread_entity_dedupe',
      limit: 1,
    });
    const passageIds = results[0]?.passages?.map((passage) => passage.passageId) ?? [];

    assert.ok(passageIds.includes('msg-crowded'));
    assert.ok(passageIds.includes('msg-rare'), 'raw entity mention pool should cap unique passages, not raw rows');
  });

  it('keeps project-only aliases out of global-only resolution', async () => {
    const { KnowledgeResolver } = await import('../../dist/domains/memory/KnowledgeResolver.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const globalStore = new SqliteEvidenceStore(':memory:');
    await globalStore.initialize();

    await seedYouEntity();
    await store.upsert([
      {
        anchor: 'F209-private-entity-note',
        kind: 'feature',
        status: 'active',
        title: 'Private entity note',
        summary: '铲屎官 private project-only alias evidence.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    const resolver = new KnowledgeResolver({ projectStore: store, globalStore });

    const globalOnly = await resolver.resolve('CVO', { dimension: 'global', limit: 5 });
    assert.equal(globalOnly.results.length, 0);

    const projectOnly = await resolver.resolve('CVO', { dimension: 'project', limit: 5 });
    assert.equal(projectOnly.results[0].anchor, 'F209-private-entity-note');
    assert.equal(projectOnly.results[0].entityMatches?.[0]?.entityId, 'person:landy');
  });

  it('works through collection search while preserving private collection redaction', async () => {
    const { KnowledgeResolver } = await import('../../dist/domains/memory/KnowledgeResolver.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const internalStore = new SqliteEvidenceStore(':memory:');
    const privateStore = new SqliteEvidenceStore(':memory:');
    await internalStore.initialize();
    await privateStore.initialize();

    for (const targetStore of [internalStore, privateStore]) {
      await targetStore.upsertEntities([
        {
          entityId: 'person:landy',
          type: 'person',
          canonicalName: 'You',
          aliases: ['you', '铲屎官', 'CVO'],
          provenance: [{ source: 'F209 Phase B test' }],
          updatedAt: '2026-05-22T00:00:00Z',
        },
      ]);
    }
    await internalStore.upsert([
      {
        anchor: 'F209-internal-alias-note',
        kind: 'feature',
        status: 'active',
        title: 'Internal alias note',
        summary: '铲屎官 alias in internal collection.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);
    await privateStore.upsert([
      {
        anchor: 'private-family-alias-note',
        kind: 'feature',
        status: 'active',
        title: 'Private family alias note',
        summary: '铲屎官 alias in private collection.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    const now = '2026-05-22T00:00:00Z';
    const catalog = new LibraryCatalog();
    catalog.register({
      id: 'project:cat-cafe-test',
      kind: 'project',
      name: 'cat-cafe-test',
      displayName: 'Cat Cafe Test',
      root: '/tmp/cat-cafe-test',
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: now,
      updatedAt: now,
    });
    catalog.register({
      id: 'world:private-family',
      kind: 'world',
      name: 'private-family',
      displayName: 'Private Family',
      root: '/tmp/private-family',
      sensitivity: 'private',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
      createdAt: now,
      updatedAt: now,
    });
    const stores = new Map([
      ['project:cat-cafe-test', internalStore],
      ['world:private-family', privateStore],
    ]);
    const resolver = new KnowledgeResolver({ projectStore: internalStore, catalog, stores });

    const libraryResult = await resolver.resolve('CVO', { dimension: 'library', limit: 5 });
    assert.deepEqual(
      libraryResult.results.map((r) => r.anchor),
      ['F209-internal-alias-note'],
    );
    assert.equal(libraryResult.results[0].entityMatches?.[0]?.entityId, 'person:landy');

    const privateResult = await resolver.resolve('CVO', {
      dimension: 'collection',
      collections: ['world:private-family'],
      limit: 5,
    });
    assert.equal(privateResult.results[0].anchor, 'private-family-alias-note');
    assert.equal(privateResult.results[0].title, '[redacted — private collection]');
    assert.equal(privateResult.results[0].entityMatches, undefined);
  });

  it('caps entity-prepended semantic results so vector hits still survive', async () => {
    const { VectorStore } = await import('../../dist/domains/memory/VectorStore.js');
    const { ensureVectorTable } = await import('../../dist/domains/memory/schema.js');

    await seedYouEntity();
    await store.upsert([
      {
        anchor: 'entity-hit-one',
        kind: 'feature',
        status: 'active',
        title: 'Entity hit one',
        summary: '铲屎官 mentioned entity aliases here.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
      {
        anchor: 'entity-hit-two',
        kind: 'feature',
        status: 'active',
        title: 'Entity hit two',
        summary: 'CVO also appears in this entity-only document.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
      {
        anchor: 'semantic-vector-hit',
        kind: 'feature',
        status: 'active',
        title: 'Semantic vector hit',
        summary: 'This result has no entity alias but is the closest embedding hit.',
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 3);
    const vectorStore = new VectorStore(db, 3);
    vectorStore.upsert('entity-hit-one', new Float32Array([0, 1, 0]));
    vectorStore.upsert('entity-hit-two', new Float32Array([0, 0.9, 0]));
    vectorStore.upsert('semantic-vector-hit', new Float32Array([1, 0, 0]));
    store.setEmbedDeps({
      embedding: createEmbedding(new Float32Array([1, 0, 0])),
      vectorStore,
      mode: 'on',
    });

    const results = await store.search('CVO', { mode: 'semantic', scope: 'docs', limit: 2 });
    const anchors = results.map((r) => r.anchor);

    assert.ok(anchors.includes('entity-hit-one') || anchors.includes('entity-hit-two'));
    assert.ok(anchors.includes('semantic-vector-hit'), 'entity prepending should not starve semantic hits');

    const limited = await store.search('CVO', { mode: 'semantic', scope: 'docs', limit: 1 });
    assert.equal(limited.length, 1, 'entity merge must still honor the requested limit');
  });
});
