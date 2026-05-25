import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

describe('F209 entity mention indexing', () => {
  it('indexes thread message passages as entity mentions during rebuild', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const root = mkdtempSync(join(tmpdir(), 'f209-entity-index-'));
    const docsRoot = join(root, 'docs');
    mkdirSync(docsRoot);

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsertEntities([
      {
        entityId: 'person:landy',
        type: 'person',
        canonicalName: 'You',
        aliases: ['you', '铲屎官', 'CVO'],
        provenance: [{ source: 'F209 Phase B test' }],
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    const threadListFn = () => [
      {
        id: 'thread_entity_index',
        title: 'Entity index thread',
        participants: ['codex'],
        threadMemory: { summary: 'Thread summary' },
        lastActiveAt: Date.parse('2026-05-22T02:00:00Z'),
      },
    ];
    const messageListFn = () => [
      {
        id: 'm1',
        content: '铲屎官要求 alias registry 不能变成 classifier。',
        catId: 'codex',
        timestamp: Date.parse('2026-05-22T02:00:00Z'),
      },
    ];

    const builder = new IndexBuilder(store, docsRoot, undefined, undefined, threadListFn, messageListFn);
    await builder.rebuild({ force: true });

    const rows = store
      .getDb()
      .prepare('SELECT entity_id, doc_anchor, passage_id, surface, source FROM entity_mentions')
      .all();
    assert.ok(
      rows.some(
        (r) =>
          r.entity_id === 'person:landy' &&
          r.doc_anchor === 'thread-thread_entity_index' &&
          r.passage_id === 'msg-m1' &&
          r.surface === '铲屎官' &&
          r.source === 'passage',
      ),
    );

    const results = await store.search('CVO', { depth: 'raw', scope: 'threads', limit: 5 });
    assert.equal(results[0].anchor, 'thread-thread_entity_index');
    assert.equal(results[0].passages?.[0]?.messageId, 'm1');
    assert.equal(results[0].entityMatches?.[0]?.entityId, 'person:landy');
  });

  it('skips orphan passage rows when rebuilding entity mentions', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsertEntities([
      {
        entityId: 'person:landy',
        type: 'person',
        canonicalName: 'You',
        aliases: ['you', '铲屎官', 'CVO'],
        provenance: [{ source: 'F209 Phase B test' }],
        updatedAt: '2026-05-22T00:00:00Z',
      },
    ]);

    const db = store.getDb();
    db.prepare(
      `INSERT INTO evidence_passages
       (doc_anchor, passage_id, content, speaker, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'deleted-thread-anchor',
      'msg-orphan',
      '铲屎官 mentioned in an orphan passage row.',
      'codex',
      0,
      '2026-05-22T03:00:00Z',
    );

    await assert.doesNotReject(() => store.refreshEntityMentions());
    const rows = db.prepare('SELECT * FROM entity_mentions WHERE doc_anchor = ?').all('deleted-thread-anchor');
    assert.equal(rows.length, 0);
  });

  it('does not rebuild all entity mentions when unchanged seeds are upserted', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'thread-entity-seed-noop',
        kind: 'thread',
        status: 'active',
        title: 'Entity seed no-op thread',
        summary: '铲屎官 asked whether restart should reindex every entity mention.',
        updatedAt: '2026-05-23T00:00:00.000Z',
      },
    ]);

    const seed = {
      entityId: 'person:landy',
      type: 'person',
      canonicalName: 'You',
      aliases: ['you', '铲屎官', 'CVO'],
      provenance: [{ source: 'F209 Phase B.1 test seed' }],
      updatedAt: '2026-05-23T00:00:00Z',
    };
    await store.upsertEntities([seed]);

    const db = store.getDb();
    db.exec(`
      CREATE TEMP TABLE mention_delete_log(entity_id TEXT NOT NULL);
      CREATE TEMP TRIGGER log_entity_mention_delete
      AFTER DELETE ON entity_mentions
      BEGIN
        INSERT INTO mention_delete_log(entity_id) VALUES (OLD.entity_id);
      END;
    `);

    await store.upsertEntities([seed]);

    const deleteCount = db.prepare('SELECT COUNT(*) AS count FROM mention_delete_log').get().count;
    assert.equal(deleteCount, 0, 'unchanged seeds must not trigger a full entity_mentions rebuild');
  });
});
