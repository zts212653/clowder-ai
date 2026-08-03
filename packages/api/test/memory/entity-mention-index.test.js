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
        aliases: ['you', 'co-creator', 'operator'],
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
        content: 'co-creator要求 alias registry 不能变成 classifier。',
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
          r.surface === 'co-creator' &&
          r.source === 'passage',
      ),
    );

    const results = await store.search('operator', { depth: 'raw', scope: 'threads', limit: 5 });
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
        aliases: ['you', 'co-creator', 'operator'],
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
      'co-creator mentioned in an orphan passage row.',
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
        summary: 'co-creator asked whether restart should reindex every entity mention.',
        updatedAt: '2026-05-23T00:00:00.000Z',
      },
    ]);

    const seed = {
      entityId: 'person:landy',
      type: 'person',
      canonicalName: 'You',
      aliases: ['you', 'co-creator', 'operator'],
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

  it('refreshes only entities changed by an F260 conflict resolution', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    await store.upsert([
      {
        anchor: 'doc:f260-targeted-refresh',
        kind: 'feature',
        status: 'active',
        title: 'F260 targeted mention refresh',
        summary: '沉迷护栏、猫猫安全护栏、稳定别名都在这里。',
        updatedAt: '2026-07-20T00:00:00.000Z',
      },
    ]);
    await store.upsertEntities(
      [
        {
          entityId: 'concept:沉迷护栏',
          type: 'concept',
          canonicalName: '防AI沉迷护栏',
          aliases: ['沉迷护栏'],
          provenance: [{ source: 'proposal', anchor: 'ep-old' }],
          stance: 'endorsed',
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-19T00:00:00.000Z',
        },
        {
          entityId: 'concept:unrelated',
          type: 'concept',
          canonicalName: '其他实体',
          aliases: ['稳定别名'],
          provenance: [{ source: 'test', anchor: 'unrelated' }],
          stance: 'endorsed',
          visibilityScope: 'workspace',
          status: 'active',
          updatedAt: '2026-07-19T00:00:00.000Z',
        },
      ],
      { source: 'system' },
    );

    const db = store.getDb();
    assert.ok(
      db.prepare("SELECT COUNT(*) AS n FROM entity_mentions WHERE entity_id = 'concept:unrelated'").get().n > 0,
      'fixture must start with an unrelated mention',
    );
    db.exec(`
      CREATE TEMP TABLE mention_delete_log(entity_id TEXT NOT NULL);
      CREATE TEMP TRIGGER log_f260_mention_delete
      AFTER DELETE ON entity_mentions
      BEGIN
        INSERT INTO mention_delete_log(entity_id) VALUES (OLD.entity_id);
      END;
    `);

    const incoming = {
      entityId: 'concept:沉迷护栏',
      type: 'concept',
      canonicalName: '防AI沉迷护栏',
      aliases: ['沉迷护栏', '猫猫安全护栏'],
      provenance: [{ source: 'proposal', anchor: 'ep-targeted-refresh' }],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      status: 'active',
      updatedAt: '2026-07-20T00:01:00.000Z',
    };
    const conflict = await store.inspectEntityConflict(incoming, 'user-1');
    await store.resolveEntityConflict(
      incoming,
      { action: 'merge-aliases', fingerprint: conflict.fingerprint },
      { source: 'proposal-approval', actorId: 'user-1', proposalId: 'ep-targeted-refresh' },
    );

    const deletedEntityIds = db
      .prepare('SELECT DISTINCT entity_id FROM mention_delete_log ORDER BY entity_id')
      .all()
      .map(({ entity_id }) => entity_id);
    assert.deepEqual(
      deletedEntityIds,
      ['concept:沉迷护栏'],
      'a one-entity decision must not delete and rebuild every other entity projection',
    );
    assert.ok(
      db.prepare("SELECT COUNT(*) AS n FROM entity_mentions WHERE entity_id = 'concept:unrelated'").get().n > 0,
      'unrelated mentions must survive the targeted refresh',
    );
    assert.ok(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM entity_mentions WHERE entity_id = 'concept:沉迷护栏' AND surface = '猫猫安全护栏'",
        )
        .get().n > 0,
      'the newly merged alias must be projected immediately',
    );
  });
});
