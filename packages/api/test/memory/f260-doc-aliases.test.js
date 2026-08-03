// F260 Phase A: doc_aliases table, registry extensions, mirror job
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';

describe('F260 Phase A — doc_aliases & registry extensions', () => {
  let db;

  beforeEach(async () => {
    const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
  });

  // ─── T1: Schema migration ──────────────────────────────────────────

  describe('V30 schema migration', () => {
    it('creates doc_aliases table with correct columns', () => {
      const info = db.prepare("PRAGMA table_info('doc_aliases')").all();
      const cols = info.map((c) => c.name);
      assert.deepEqual(cols, ['alias_norm', 'alias', 'doc_anchor', 'source', 'authority_tier', 'created_at']);
    });

    it('doc_aliases has composite primary key (alias_norm, doc_anchor)', () => {
      const now = new Date().toISOString();
      // Same alias pointing to two different docs — should succeed
      db.prepare(
        'INSERT INTO doc_aliases (alias_norm, alias, doc_anchor, source, authority_tier, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('test alias', 'Test Alias', 'doc-1', 'doc-title', 'primary', now);
      db.prepare(
        'INSERT INTO doc_aliases (alias_norm, alias, doc_anchor, source, authority_tier, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('test alias', 'Test Alias', 'doc-2', 'doc-title', 'primary', now);

      const rows = db.prepare('SELECT * FROM doc_aliases WHERE alias_norm = ?').all('test alias');
      assert.equal(rows.length, 2);

      // Same (alias_norm, doc_anchor) should fail (duplicate PK)
      assert.throws(() => {
        db.prepare(
          'INSERT INTO doc_aliases (alias_norm, alias, doc_anchor, source, authority_tier, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run('test alias', 'Test Alias', 'doc-1', 'doc-title', 'primary', now);
      });
    });

    it('entity_registry has stance column with default unknown', () => {
      const info = db.prepare("PRAGMA table_info('entity_registry')").all();
      const stanceCol = info.find((c) => c.name === 'stance');
      assert.ok(stanceCol, 'stance column should exist');
      assert.equal(stanceCol.dflt_value, "'unknown'");
    });

    it('entity_registry has visibility_scope column with default workspace', () => {
      const info = db.prepare("PRAGMA table_info('entity_registry')").all();
      const col = info.find((c) => c.name === 'visibility_scope');
      assert.ok(col, 'visibility_scope column should exist');
      assert.equal(col.dflt_value, "'workspace'");
    });

    it('entity_registry has status column with default active', () => {
      const info = db.prepare("PRAGMA table_info('entity_registry')").all();
      const col = info.find((c) => c.name === 'status');
      assert.ok(col, 'status column should exist');
      assert.equal(col.dflt_value, "'active'");
    });

    it('existing entity records get default values after migration', async () => {
      const { EntityRegistryStore } = await import('../../dist/domains/memory/EntityRegistry.js');
      const registry = new EntityRegistryStore(db);
      registry.upsert([
        {
          entityId: 'person:landy',
          type: 'person',
          canonicalName: 'You',
          aliases: ['operator'],
          provenance: [{ source: 'test' }],
          updatedAt: '2026-07-08T00:00:00Z',
        },
      ]);

      const row = db
        .prepare('SELECT stance, visibility_scope, status FROM entity_registry WHERE entity_id = ?')
        .get('person:landy');
      assert.equal(row.stance, 'unknown');
      assert.equal(row.visibility_scope, 'workspace');
      assert.equal(row.status, 'active');
    });

    it('migration is idempotent (running twice does not error)', async () => {
      const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
      // Already applied in beforeEach; applying again should not throw
      assert.doesNotThrow(() => applyMigrations(db));
    });

    it('V30 cleanup removes dev/test cat entities from entity_registry', async () => {
      // Create a separate DB at V29 (before V30 cleanup), insert garbage, then upgrade.
      const { applyMigrations } = await import('../../dist/domains/memory/schema.js');
      const freshDb = new Database(':memory:');
      freshDb.pragma('journal_mode = WAL');
      freshDb.pragma('foreign_keys = ON');

      // Apply migrations up to V29 by temporarily rolling back the version marker
      applyMigrations(freshDb);
      // Reset to V29 to test the V30 cleanup path even after later migrations exist.
      freshDb.prepare('DELETE FROM schema_version WHERE version >= 30').run();

      // Remove V30 columns/table so we can re-apply cleanly
      // (doc_aliases and extra columns already exist, but cleanup DELETE is the test target)

      // Insert garbage entities BEFORE V30 runs
      const { EntityRegistryStore } = await import('../../dist/domains/memory/EntityRegistry.js');
      const registry = new EntityRegistryStore(freshDb);
      registry.upsert([
        {
          entityId: 'cat:fable5-test',
          type: 'cat',
          canonicalName: 'Test Cat',
          aliases: ['test'],
          provenance: [{ source: 'test' }],
          updatedAt: '2026-07-08T00:00:00Z',
        },
        {
          entityId: 'cat:cat-f70tzwib',
          type: 'cat',
          canonicalName: 'Auto Cat',
          aliases: ['auto'],
          provenance: [{ source: 'test' }],
          updatedAt: '2026-07-08T00:00:00Z',
        },
        {
          entityId: 'cat:opus',
          type: 'cat',
          canonicalName: 'Legit Cat',
          aliases: ['opus-cat'],
          provenance: [{ source: 'test' }],
          updatedAt: '2026-07-08T00:00:00Z',
        },
      ]);

      // Now apply V30 and subsequent migrations (V30 includes the cleanup DELETE).
      applyMigrations(freshDb);

      const remaining = freshDb.prepare("SELECT entity_id FROM entity_registry WHERE entity_type = 'cat'").all();
      const ids = remaining.map((r) => r.entity_id);
      assert.ok(!ids.includes('cat:fable5-test'), 'dev/test cat should be cleaned');
      assert.ok(!ids.includes('cat:cat-f70tzwib'), 'auto-generated cat should be cleaned');
      assert.ok(ids.includes('cat:opus'), 'legitimate cat should survive cleanup');
      freshDb.close();
    });
  });

  // ─── T2: Doc alias mirror job ──────────────────────────────────────

  describe('doc alias mirror job', () => {
    // Helper: insert a fake evidence_doc for mirror to discover
    function insertDoc(anchor, title, kind = 'architecture', provenanceTier = 'primary') {
      db.prepare(
        `INSERT OR REPLACE INTO evidence_docs
         (anchor, kind, status, title, summary, keywords, source_path, updated_at, provenance_tier)
         VALUES (?, ?, 'active', ?, '', '', ?, datetime('now'), ?)`,
      ).run(anchor, kind, title, `docs/${anchor}.md`, provenanceTier);
    }

    it('mirrors doc titles into doc_aliases', async () => {
      insertDoc('cat-pack-manifesto', '猫猫共犯伙伴-记忆篇', 'architecture', 'primary');
      insertDoc('memory-philosophy', 'Memory Philosophy & Governance', 'architecture', 'primary');

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);

      const rows = db.prepare('SELECT * FROM doc_aliases ORDER BY alias_norm').all();
      assert.ok(rows.length >= 2, `expected ≥2 aliases, got ${rows.length}`);

      const manifesto = rows.find((r) => r.doc_anchor === 'cat-pack-manifesto');
      assert.ok(manifesto, 'should mirror manifesto doc');
      assert.equal(manifesto.source, 'doc-title');
      assert.equal(manifesto.authority_tier, 'primary');
    });

    it('filters out stop-word pattern titles', async () => {
      insertDoc('readme-doc', 'README', 'architecture');
      insertDoc('index-doc', 'Index', 'architecture');
      insertDoc('phase-a-doc', 'Phase A', 'plan');
      insertDoc('todo-doc', 'TODO', 'plan');
      insertDoc('misc-doc', 'Misc', 'architecture');
      insertDoc('real-doc', '记忆系统写侧解剖尸检报告', 'architecture');

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);

      const rows = db.prepare('SELECT * FROM doc_aliases').all();
      const anchors = new Set(rows.map((r) => r.doc_anchor));
      assert.ok(!anchors.has('readme-doc'), 'README should be filtered');
      assert.ok(!anchors.has('index-doc'), 'Index should be filtered');
      assert.ok(!anchors.has('phase-a-doc'), 'Phase A should be filtered');
      assert.ok(!anchors.has('todo-doc'), 'TODO should be filtered');
      assert.ok(!anchors.has('misc-doc'), 'Misc should be filtered');
      assert.ok(anchors.has('real-doc'), 'Real doc should pass filter');
    });

    it('filters out generic single-word English titles (cloud AC-A1: test collision)', async () => {
      insertDoc('test-doc', 'test', 'thread');
      insertDoc('debug-doc', 'debug', 'thread');
      insertDoc('draft-doc', 'draft', 'thread');
      insertDoc('demo-doc', 'demo', 'thread');
      insertDoc('temp-doc', 'temp', 'thread');
      insertDoc('setup-doc', 'setup', 'thread');
      insertDoc('notes-doc', 'notes', 'thread');
      insertDoc('untitled-doc', 'untitled', 'thread');
      insertDoc('real-thread', '记忆系统设计讨论', 'thread');

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);

      const rows = db.prepare('SELECT * FROM doc_aliases').all();
      const anchors = new Set(rows.map((r) => r.doc_anchor));
      assert.ok(!anchors.has('test-doc'), '"test" should be filtered as generic');
      assert.ok(!anchors.has('debug-doc'), '"debug" should be filtered as generic');
      assert.ok(!anchors.has('draft-doc'), '"draft" should be filtered as generic');
      assert.ok(!anchors.has('demo-doc'), '"demo" should be filtered as generic');
      assert.ok(!anchors.has('temp-doc'), '"temp" should be filtered as generic');
      assert.ok(!anchors.has('setup-doc'), '"setup" should be filtered as generic');
      assert.ok(!anchors.has('notes-doc'), '"notes" should be filtered as generic');
      assert.ok(!anchors.has('untitled-doc'), '"untitled" should be filtered as generic');
      assert.ok(anchors.has('real-thread'), 'Real thread title should pass');
    });

    it('filters out auto-generated operational titles (session/rotation patterns)', async () => {
      insertDoc('session-1', 'session 0 — codex @ thread_eval_abc', 'session');
      insertDoc('session-2', 'Session 0 — gpt52 @ thread_mo6r8', 'session');
      insertDoc('mr-review-1', 'mr review (auto-rotated from thread_mqcb399ktegukxdy)', 'thread');
      insertDoc('mr-review-2', 'MR review (auto-rotated from thread_mqiwclan)', 'thread');
      insertDoc('real-session', 'Architecture review session with You', 'session');
      insertDoc('gate-report-1', 'Public Delta Gate Report', 'ops');
      insertDoc('triage-1', 'Review Triage (未匹配)', 'thread');
      insertDoc('real-review', 'Review of memory subsystem architecture', 'architecture');

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);

      const rows = db.prepare('SELECT * FROM doc_aliases').all();
      const anchors = new Set(rows.map((r) => r.doc_anchor));
      assert.ok(!anchors.has('session-1'), '"session 0 — ..." should be filtered');
      assert.ok(!anchors.has('session-2'), '"Session 0 — ..." should be filtered');
      assert.ok(!anchors.has('mr-review-1'), '"mr review (auto-rotated..." should be filtered');
      assert.ok(!anchors.has('mr-review-2'), '"MR review (auto-rotated..." should be filtered');
      assert.ok(!anchors.has('gate-report-1'), '"Public Delta Gate Report" should be filtered (gpt52 P1)');
      assert.ok(!anchors.has('triage-1'), '"Review Triage (未匹配)" should be filtered');
      assert.ok(anchors.has('real-session'), 'Genuine session-topic title should pass');
      assert.ok(anchors.has('real-review'), 'Genuine review-topic title should pass');
    });

    it('filters out titles shorter than 4 characters', async () => {
      insertDoc('abc-doc', 'ABC', 'architecture');
      insertDoc('abcd-doc', 'ABCD title here', 'architecture');

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);

      const rows = db.prepare('SELECT * FROM doc_aliases').all();
      const anchors = new Set(rows.map((r) => r.doc_anchor));
      assert.ok(!anchors.has('abc-doc'), 'Short title (<4 chars) should be filtered');
      assert.ok(anchors.has('abcd-doc'), 'Title ≥4 chars should pass');
    });

    it('is idempotent — delete-rebuild pattern (no duplicates on re-run)', async () => {
      insertDoc('test-doc', 'Memory Philosophy', 'architecture');

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);
      mirrorDocAliases(db); // second run

      const rows = db.prepare("SELECT * FROM doc_aliases WHERE doc_anchor = 'test-doc'").all();
      assert.equal(rows.length, 1, 'should not duplicate on re-run');
    });

    it('removes aliases for deleted docs on re-mirror (INV-8)', async () => {
      insertDoc('ephemeral-doc', 'Ephemeral Architecture Doc', 'architecture');

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);

      let rows = db.prepare("SELECT * FROM doc_aliases WHERE doc_anchor = 'ephemeral-doc'").all();
      assert.equal(rows.length, 1, 'should exist after first mirror');

      // Delete the doc
      db.prepare("DELETE FROM evidence_docs WHERE anchor = 'ephemeral-doc'").run();
      mirrorDocAliases(db);

      rows = db.prepare("SELECT * FROM doc_aliases WHERE doc_anchor = 'ephemeral-doc'").all();
      assert.equal(rows.length, 0, 'should be removed after doc deletion + re-mirror');
    });

    it('carries authority_tier from evidence_docs.provenance_tier', async () => {
      insertDoc('tier-doc', 'Important Architecture Decision', 'decision', 'authoritative');

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);

      const row = db.prepare("SELECT authority_tier FROM doc_aliases WHERE doc_anchor = 'tier-doc'").get();
      assert.ok(row, 'should have mirrored alias');
      assert.equal(row.authority_tier, 'authoritative');
    });
  });

  // ─── T3: Feature mirror ───────────────────────────────────────────

  describe('feature doc mirror into doc_aliases', () => {
    function insertFeatureDoc(fId, title) {
      db.prepare(
        `INSERT OR REPLACE INTO evidence_docs
         (anchor, kind, status, title, summary, keywords, source_path, updated_at, provenance_tier)
         VALUES (?, 'feature', 'active', ?, '', ?, ?, datetime('now'), 'primary')`,
      ).run(fId, title, fId, `docs/features/${fId}.md`);
    }

    it('mirrors feature F-number as separate feature-id alias', async () => {
      insertFeatureDoc('F260', 'F260: 记忆写侧尸检与实体解引用');

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);

      const row = db.prepare("SELECT * FROM doc_aliases WHERE source = 'feature-id' AND doc_anchor = 'F260'").get();
      assert.ok(row, 'F-number alias should exist');
      assert.equal(row.alias_norm, 'f260');
      assert.equal(row.alias, 'F260');
    });

    it('feature docs also get their title mirrored via doc-title source', async () => {
      insertFeatureDoc('F260', 'F260: Write-Side Autopsy');

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);

      const rows = db.prepare("SELECT * FROM doc_aliases WHERE doc_anchor = 'F260' ORDER BY source").all();
      const sources = rows.map((r) => r.source);
      assert.ok(sources.includes('doc-title'), 'should have doc-title source');
      assert.ok(sources.includes('feature-id'), 'should have feature-id source');
    });
  });

  // ─── INV-2: Writer mutual exclusion ────────────────────────────────

  describe('INV-2: doc_aliases and entity_registry writer mutual exclusion', () => {
    it('mirrorDocAliases only writes doc_aliases, never entity_registry', async () => {
      db.prepare(
        `INSERT INTO evidence_docs
         (anchor, kind, status, title, summary, keywords, source_path, updated_at)
         VALUES ('inv2-doc', 'architecture', 'active', 'Test Document Title', '', '', 'docs/test.md', datetime('now'))`,
      ).run();

      const regBefore = db.prepare('SELECT count(*) as cnt FROM entity_registry').get().cnt;

      const { mirrorDocAliases } = await import('../../dist/domains/memory/doc-alias-mirror.js');
      mirrorDocAliases(db);

      const regAfter = db.prepare('SELECT count(*) as cnt FROM entity_registry').get().cnt;
      assert.equal(regAfter, regBefore, 'mirrorDocAliases must NOT write to entity_registry (INV-2)');
    });
  });
});
