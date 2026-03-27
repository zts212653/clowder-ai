/**
 * F129 PackKnowledgeScope Tests — AC-A10 pack-scoped knowledge isolation
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const FIXTURES = join(import.meta.dirname, '__fixtures__');
const VALID_PACK = join(FIXTURES, 'valid-packs', 'quant-cats');

// ─── Evidence store with temp SQLite file ────────────────────────────

async function createTestStore() {
  const dir = await mkdtemp(join(tmpdir(), 'pack-evidence-'));
  tmpDirs.push(dir);
  const dbPath = join(dir, 'evidence.sqlite');

  const { SqliteEvidenceStore } = await import('../dist/domains/memory/SqliteEvidenceStore.js');
  const store = new SqliteEvidenceStore(dbPath);
  await store.initialize();
  return { store };
}

// ─── Temp directory management ───────────────────────────────────────

const tmpDirs = [];

async function createTmpDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pack-knowledge-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

// ═══════════════════════════════════════════════════════════════════════

describe('PackKnowledgeScope', () => {
  test('registers pack knowledge files under pack scope', async () => {
    const { store } = await createTestStore();
    const { PackKnowledgeScope } = await import('../dist/domains/packs/PackKnowledgeScope.js');
    const scope = new PackKnowledgeScope(store);

    const knowledgeDir = join(VALID_PACK, 'knowledge');
    const count = await scope.registerKnowledge('quant-cats', knowledgeDir);

    assert.ok(count > 0, 'Should register at least one knowledge file');

    // Verify the item was stored with pack_id
    const item = await store.getByAnchor('pack:quant-cats:finance-basics');
    assert.ok(item, 'Should find registered knowledge item');
    assert.equal(item.kind, 'pack-knowledge');
    assert.equal(item.packId, 'quant-cats');
    assert.ok(item.title.length > 0, 'Should have a title');
  });

  test('global search does NOT include pack knowledge', async () => {
    const { store } = await createTestStore();
    const { PackKnowledgeScope } = await import('../dist/domains/packs/PackKnowledgeScope.js');
    const scope = new PackKnowledgeScope(store);

    // Register pack knowledge
    const knowledgeDir = join(VALID_PACK, 'knowledge');
    await scope.registerKnowledge('quant-cats', knowledgeDir);

    // Register a regular evidence item
    await store.upsert([
      {
        anchor: 'global-doc-1',
        kind: 'feature',
        status: 'active',
        title: 'Global Feature Doc',
        summary: 'This is a global document about finance',
        updatedAt: new Date().toISOString(),
      },
    ]);

    // Search for 'finance' with kind filter — should exclude pack
    const results = await store.search('finance', { kind: 'feature' });
    assert.ok(
      results.every((r) => r.kind !== 'pack-knowledge'),
      'Feature-scoped search must not return pack-knowledge items',
    );

    // P1-2 fix: search WITHOUT kind filter should ALSO exclude pack-knowledge
    const globalResults = await store.search('finance');
    assert.ok(
      globalResults.every((r) => r.kind !== 'pack-knowledge'),
      'Unfiltered global search must not return pack-knowledge items (AC-A10)',
    );
    assert.ok(globalResults.length > 0, 'Should still find global doc');
  });

  test('search with pack-knowledge kind only returns pack items', async () => {
    const { store } = await createTestStore();
    const { PackKnowledgeScope } = await import('../dist/domains/packs/PackKnowledgeScope.js');
    const scope = new PackKnowledgeScope(store);

    const knowledgeDir = join(VALID_PACK, 'knowledge');
    await scope.registerKnowledge('quant-cats', knowledgeDir);

    const results = await store.search('finance', { kind: 'pack-knowledge' });
    assert.ok(results.length > 0, 'Should find pack knowledge');
    assert.ok(
      results.every((r) => r.kind === 'pack-knowledge'),
      'All results should be pack-knowledge',
    );
    assert.ok(
      results.every((r) => r.packId === 'quant-cats'),
      'All results should belong to quant-cats pack',
    );
  });

  test('removeKnowledge deletes pack-scoped entries', async () => {
    const { store } = await createTestStore();
    const { PackKnowledgeScope } = await import('../dist/domains/packs/PackKnowledgeScope.js');
    const scope = new PackKnowledgeScope(store);

    const knowledgeDir = join(VALID_PACK, 'knowledge');
    await scope.registerKnowledge('quant-cats', knowledgeDir);

    // Verify item exists
    const before = await store.getByAnchor('pack:quant-cats:finance-basics');
    assert.ok(before, 'Should exist before removal');

    // Remove
    await scope.removeKnowledge('quant-cats');

    // Verify item is gone
    const after = await store.getByAnchor('pack:quant-cats:finance-basics');
    assert.equal(after, null, 'Should be deleted after removal');
  });

  test('returns 0 for pack without knowledge/ directory', async () => {
    const { store } = await createTestStore();
    const { PackKnowledgeScope } = await import('../dist/domains/packs/PackKnowledgeScope.js');
    const scope = new PackKnowledgeScope(store);

    const count = await scope.registerKnowledge('no-knowledge', '/nonexistent/path');
    assert.equal(count, 0, 'Should return 0 for missing directory');
  });

  test('only registers .md and .txt files', async () => {
    const { store } = await createTestStore();
    const { PackKnowledgeScope } = await import('../dist/domains/packs/PackKnowledgeScope.js');
    const scope = new PackKnowledgeScope(store);

    const tmpDir = await createTmpDir();
    const knowledgeDir = join(tmpDir, 'knowledge');
    await mkdir(knowledgeDir);

    // Create various files
    await writeFile(join(knowledgeDir, 'valid.md'), '# Valid\nSome content');
    await writeFile(join(knowledgeDir, 'also-valid.txt'), 'Plain text content');
    await writeFile(join(knowledgeDir, 'ignored.yaml'), 'key: value');
    await writeFile(join(knowledgeDir, 'ignored.json'), '{}');

    const count = await scope.registerKnowledge('test-pack', knowledgeDir);
    assert.equal(count, 2, 'Should only register .md and .txt files');
  });

  test('extracts title from markdown heading', async () => {
    const { store } = await createTestStore();
    const { PackKnowledgeScope } = await import('../dist/domains/packs/PackKnowledgeScope.js');
    const scope = new PackKnowledgeScope(store);

    const tmpDir = await createTmpDir();
    const knowledgeDir = join(tmpDir, 'knowledge');
    await mkdir(knowledgeDir);
    await writeFile(join(knowledgeDir, 'my-doc.md'), '# Custom Title\n\nContent here');

    await scope.registerKnowledge('title-test', knowledgeDir);

    const item = await store.getByAnchor('pack:title-test:my-doc');
    assert.ok(item);
    assert.equal(item.title, 'Custom Title');
  });

  test('schema V6 migration adds pack_id column', async () => {
    const { CURRENT_SCHEMA_VERSION } = await import('../dist/domains/memory/schema.js');
    assert.equal(CURRENT_SCHEMA_VERSION, 7, 'Current schema version should be 7');

    // Create a store and check schema via its exposed db
    const { store } = await createTestStore();
    const db = store.getDb();

    // Verify pack_id column exists
    const info = db.prepare("PRAGMA table_info('evidence_docs')").all();
    const packIdCol = info.find((col) => col.name === 'pack_id');
    assert.ok(packIdCol, 'evidence_docs should have pack_id column');

    // Verify migration version
    const version = db.prepare('SELECT MAX(version) as v FROM schema_version').get();
    assert.equal(version.v, 7, 'Schema version should be 7');
  });
});
