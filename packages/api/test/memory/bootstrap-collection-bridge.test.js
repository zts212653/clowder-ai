// F152: Bootstrap → Collection Pipeline Bridge
// Verifies ensureProjectCollection creates manifest, store, and indexes docs

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

function expectedCollectionId(projectPath) {
  let name = basename(projectPath)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  if (!name || !/^[a-z]/.test(name)) name = `p${name}`;
  const hash = createHash('sha256').update(resolve(projectPath)).digest('hex').slice(0, 8);
  return `project:${name}-${hash}`;
}

describe('ensureProjectCollection', () => {
  let ensureProjectCollection, LibraryCatalog;
  let tmpProject, tmpDataDir;

  beforeEach(async () => {
    ({ ensureProjectCollection } = await import('../../dist/domains/memory/bootstrap-collection-bridge.js'));
    ({ LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js'));

    tmpProject = mkdtempSync(join(tmpdir(), 'f152-bridge-'));
    mkdirSync(join(tmpProject, 'docs'));
    writeFileSync(join(tmpProject, 'docs', 'README.md'), '# My Project\n\nOverview of the project.');
    writeFileSync(join(tmpProject, 'docs', 'guide.md'), '# Guide\n\nHow to use this.');
    writeFileSync(join(tmpProject, 'package.json'), JSON.stringify({ name: 'test-proj' }));

    tmpDataDir = mkdtempSync(join(tmpdir(), 'f152-data-'));
  });

  afterEach(() => {
    rmSync(tmpProject, { recursive: true, force: true });
    rmSync(tmpDataDir, { recursive: true, force: true });
  });

  it('creates collection manifest and indexes docs into evidence store', async () => {
    const catalog = new LibraryCatalog();
    const stores = new Map();

    const result = await ensureProjectCollection(tmpProject, catalog, stores, tmpDataDir);

    assert.ok(result.docsIndexed >= 2, `expected ≥2 docs indexed, got ${result.docsIndexed}`);
    assert.ok(result.durationMs >= 0);

    const expectedId = expectedCollectionId(tmpProject);
    const manifest = catalog.get(expectedId);
    assert.ok(manifest, `manifest for ${expectedId} not in catalog`);
    assert.equal(manifest.kind, 'project');
    assert.equal(manifest.sensitivity, 'private');
    assert.equal(manifest.root, tmpProject);

    const store = stores.get(expectedId);
    assert.ok(store, `store for ${expectedId} not in stores map`);
  });

  it('skips re-registration if collection already exists in catalog', async () => {
    const catalog = new LibraryCatalog();
    const stores = new Map();

    const result1 = await ensureProjectCollection(tmpProject, catalog, stores, tmpDataDir);
    const result2 = await ensureProjectCollection(tmpProject, catalog, stores, tmpDataDir);

    assert.ok(result1.docsIndexed >= 2);
    assert.ok(result2.docsIndexed >= 0);
  });

  it('persists manifest to collections.json', async () => {
    const { existsSync, readFileSync } = await import('node:fs');
    const catalog = new LibraryCatalog();
    const stores = new Map();

    await ensureProjectCollection(tmpProject, catalog, stores, tmpDataDir);

    const collectionsPath = join(tmpDataDir, 'library', 'collections.json');
    assert.ok(existsSync(collectionsPath), 'collections.json should be created');
    const saved = JSON.parse(readFileSync(collectionsPath, 'utf-8'));
    assert.ok(Array.isArray(saved));
    assert.ok(saved.length >= 1);
    assert.equal(saved[saved.length - 1].kind, 'project');
  });

  it('creates store at correct path under dataDir', async () => {
    const { existsSync } = await import('node:fs');
    const catalog = new LibraryCatalog();
    const stores = new Map();

    await ensureProjectCollection(tmpProject, catalog, stores, tmpDataDir);

    const expectedId = expectedCollectionId(tmpProject);
    const safeId = expectedId.replace(/:/g, '-');
    const storePath = join(tmpDataDir, 'library', safeId, 'evidence.sqlite');
    assert.ok(existsSync(storePath), `store should exist at ${storePath}`);
  });

  it('P1-1: two projects with same basename get distinct collections', async () => {
    const parentA = mkdtempSync(join(tmpdir(), 'col-a-'));
    const parentB = mkdtempSync(join(tmpdir(), 'col-b-'));
    const projA = join(parentA, 'myapp');
    const projB = join(parentB, 'myapp');
    mkdirSync(join(projA, 'docs'), { recursive: true });
    mkdirSync(join(projB, 'docs'), { recursive: true });
    writeFileSync(join(projA, 'docs', 'a.md'), '# Project A');
    writeFileSync(join(projB, 'docs', 'b.md'), '# Project B');

    const catalog = new LibraryCatalog();
    const stores = new Map();

    await ensureProjectCollection(projA, catalog, stores, tmpDataDir);
    await ensureProjectCollection(projB, catalog, stores, tmpDataDir);

    const allManifests = catalog.list();
    const projectManifests = allManifests.filter((m) => m.kind === 'project');
    assert.equal(projectManifests.length, 2, 'should have 2 distinct project collections');

    const roots = projectManifests.map((m) => m.root);
    assert.ok(roots.includes(projA), 'projA root should be in manifests');
    assert.ok(roots.includes(projB), 'projB root should be in manifests');

    rmSync(parentA, { recursive: true, force: true });
    rmSync(parentB, { recursive: true, force: true });
  });

  it('P1-2: throws when secret is detected in project files', async () => {
    const secretProject = mkdtempSync(join(tmpdir(), 'secret-'));
    writeFileSync(join(secretProject, 'leaked.md'), '# Config\n\ntoken: ghp_AAAAAAAABBBBBBBBCCCCCCCCDDDDDDDDEEEE\n');

    const catalog = new LibraryCatalog();
    const stores = new Map();

    await assert.rejects(
      () => ensureProjectCollection(secretProject, catalog, stores, tmpDataDir),
      (err) => {
        assert.ok(err.message.includes('secret'), `error should mention secret: ${err.message}`);
        return true;
      },
    );

    rmSync(secretProject, { recursive: true, force: true });
  });

  it('P1-3: handles project paths starting with digits or symbols', async () => {
    const digitProject = mkdtempSync(join(tmpdir(), '2026-roadmap-'));
    mkdirSync(join(digitProject, 'docs'));
    writeFileSync(join(digitProject, 'docs', 'plan.md'), '# Plan');

    const catalog = new LibraryCatalog();
    const stores = new Map();

    const result = await ensureProjectCollection(digitProject, catalog, stores, tmpDataDir);
    assert.ok(result.docsIndexed >= 1);

    const expectedId = expectedCollectionId(digitProject);
    const manifest = catalog.get(expectedId);
    assert.ok(manifest, `manifest for ${expectedId} should exist in catalog`);

    rmSync(digitProject, { recursive: true, force: true });
  });

  it('P1-4: wires embeddingService into bootstrap path (production wiring)', async () => {
    const catalog = new LibraryCatalog();
    const stores = new Map();

    let embedCallCount = 0;
    const mockEmbeddingService = {
      isReady: () => true,
      reprobeIfNeeded: async () => {},
      embed: async (texts) => {
        embedCallCount += texts.length;
        return texts.map(() => new Float32Array([0.1, 0.2]));
      },
      getModelInfo: () => ({ modelId: 'test', modelRev: 'v1', dim: 2 }),
    };

    const result = await ensureProjectCollection(tmpProject, catalog, stores, tmpDataDir, () => mockEmbeddingService);

    assert.ok(result.docsIndexed >= 2, `expected ≥2 docs, got ${result.docsIndexed}`);
    assert.ok(embedCallCount >= 2, `expected ≥2 embed calls, got ${embedCallCount}`);

    const collectionId = expectedCollectionId(tmpProject);
    const store = stores.get(collectionId);
    const db = store.getDb();
    const vecCount = db.prepare('SELECT COUNT(*) as cnt FROM evidence_vectors').get();
    assert.ok(vecCount.cnt >= 2, `expected ≥2 vectors in db, got ${vecCount.cnt}`);
  });

  it('P2-1: second rebuild reports total docs not just newly indexed', async () => {
    const catalog = new LibraryCatalog();
    const stores = new Map();

    const result1 = await ensureProjectCollection(tmpProject, catalog, stores, tmpDataDir);
    assert.ok(result1.docsIndexed >= 2, `first run should index ≥2 docs, got ${result1.docsIndexed}`);

    const result2 = await ensureProjectCollection(tmpProject, catalog, stores, tmpDataDir);
    assert.ok(result2.docsIndexed >= 2, `second run should report ≥2 total docs (not 0), got ${result2.docsIndexed}`);
  });
});
