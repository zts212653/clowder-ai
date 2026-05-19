import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

describe('CollectionIndexBuilder embedding integration (bug #6)', () => {
  let CollectionIndexBuilder, FlatScanner, SqliteEvidenceStore;
  let store, dbPath;

  beforeEach(async () => {
    ({ CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js'));
    ({ FlatScanner } = await import('../../dist/domains/memory/FlatScanner.js'));
    ({ SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js'));
    dbPath = join(mkdtempSync(join(tmpdir(), 'col-embed-')), 'test.sqlite');
    store = new SqliteEvidenceStore(dbPath);
    await store.initialize();
  });

  afterEach(() => {
    store.close();
  });

  const makeManifest = (root) => ({
    id: 'test:embed',
    kind: 'domain',
    name: 'embed',
    displayName: 'Embed Test',
    root,
    sensitivity: 'internal',
    scannerLevel: 0,
    indexPolicy: { autoRebuild: true },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
    createdAt: '2026-05-13',
    updatedAt: '2026-05-13',
  });

  it('rebuild produces embeddings when embedDeps provided', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-edocs-'));
    writeFileSync(join(dir, 'a.md'), '# Alpha\n\nAlpha content about testing.');
    writeFileSync(join(dir, 'b.md'), '# Beta\n\nBeta content about embedding.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:embed');

    const embedded = [];
    const mockEmbedding = {
      isReady: () => true,
      reprobeIfNeeded: async () => {},
      embed: async (texts) => texts.map(() => new Float32Array([0.1, 0.2])),
      getModelInfo: () => ({ modelId: 'test', modelRev: 'v1', dim: 2 }),
    };
    const mockVectorStore = {
      upsert: (anchor) => embedded.push(anchor),
      checkMetaConsistency: () => ({ consistent: true, reason: 'ok' }),
      clearAll: () => {},
      initMeta: () => {},
    };

    const builder = new CollectionIndexBuilder(store, manifest, scanner, {
      embedding: mockEmbedding,
      vectorStore: mockVectorStore,
    });
    const result = await builder.rebuild();

    assert.equal(result.indexed, 2, 'should index 2 docs');
    assert.equal(embedded.length, 2, 'should produce 2 embeddings');
  });

  it('rebuild works without embedDeps (FTS-only fallback)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'col-noembed-'));
    writeFileSync(join(dir, 'c.md'), '# Charlie\n\nCharlie content.');

    const manifest = makeManifest(dir);
    const scanner = new FlatScanner('test:embed');

    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    const result = await builder.rebuild();

    assert.equal(result.indexed, 1, 'should index without embedDeps');
  });
});
