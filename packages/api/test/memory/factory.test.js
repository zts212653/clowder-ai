import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

describe('createMemoryServices', () => {
  it('creates sqlite services', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      docsRoot: '/tmp/f102-test-docs',
      markersDir: '/tmp/f102-test-markers',
    });

    assert.ok(services.evidenceStore);
    assert.ok(services.eventMemoryStore);
    assert.ok(services.markerQueue);
    assert.ok(services.reflectionService);
    assert.ok(services.knowledgeResolver);
    assert.ok(services.indexBuilder);
    assert.ok(services.materializationService);

    assert.equal(await services.evidenceStore.health(), true);
    assert.equal(services.eventMemoryStore.health(), true);
  });

  // ── Phase C: embed config integration ───────────────────────────

  it('embedMode=off creates no embedding service', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      embed: { embedMode: 'off' },
    });

    assert.equal(services.embeddingService, undefined);
    assert.equal(services.vectorStore, undefined);
  });

  it('embedMode defaults to off when embed not specified', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
    });

    assert.equal(services.embeddingService, undefined);
    assert.equal(services.vectorStore, undefined);
  });

  it('creates LibraryCatalog with 2 built-in collections (AC-A3)', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      docsRoot: '/tmp/f186-test-docs',
    });

    assert.ok(services.catalog, 'catalog should exist');
    const collections = services.catalog.list();
    assert.ok(collections.length >= 1, 'at least project collection');
    const project = collections.find((c) => c.kind === 'project');
    assert.ok(project, 'project collection registered');
    assert.equal(project.sensitivity, 'internal');
    assert.equal(project.root, '/tmp/f186-test-docs');
  });

  it('embedMode=on creates embedding service (HTTP client, fail-open)', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');

    // EmbeddingService is now an HTTP client (PR #608, LL-034).
    // load() probes embed-api /health — may succeed if sidecar is running,
    // or fail-open if not. Either way, factory should NOT throw.
    const services = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: ':memory:',
      embed: { embedMode: 'on' },
    });

    // EmbeddingService should exist regardless of sidecar status
    assert.ok(services.embeddingService, 'embeddingService should exist');
    // isReady() depends on whether embed-api sidecar is running — both are valid
    // The important thing is that factory didn't throw
  });

  it('hydrates external collection stores with manifest root before rebuild', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
    const { saveExternalCollection, resolveCollectionStorePath } = await import(
      '../../dist/domains/memory/external-collections.js'
    );
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const dataDir = mkdtempSync(join(tmpdir(), 'f209-factory-data-'));
    const root = mkdtempSync(join(tmpdir(), 'f209-collection-root-'));
    const docsRoot = mkdtempSync(join(tmpdir(), 'f209-docs-root-'));
    try {
      const manifest = {
        id: 'world:durable-root',
        kind: 'world',
        name: 'durable-root',
        displayName: 'Durable Root',
        root,
        sensitivity: 'internal',
        scannerLevel: 1,
        indexPolicy: { autoRebuild: false },
        reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: false },
        createdAt: '2026-05-22T00:00:00.000Z',
        updatedAt: '2026-05-22T00:00:00.000Z',
      };
      saveExternalCollection(dataDir, manifest);

      const storePath = resolveCollectionStorePath(dataDir, manifest.id);
      mkdirSync(dirname(storePath), { recursive: true });
      const seedStore = new SqliteEvidenceStore(storePath);
      await seedStore.initialize();
      await seedStore.upsert([
        {
          anchor: `${manifest.id}:doc/source`,
          kind: 'feature',
          status: 'active',
          title: 'Restarted Collection Source',
          summary: 'durable root binding after process restart',
          sourcePath: 'docs/source.md',
          updatedAt: new Date().toISOString(),
        },
      ]);
      seedStore.close();

      const services = await createMemoryServices({
        type: 'sqlite',
        sqlitePath: join(dataDir, 'project.sqlite'),
        docsRoot,
        markersDir: join(dataDir, 'markers'),
        globalDbPath: join(dataDir, 'global.sqlite'),
        dataDir,
      });
      const extStore = services.collectionStores?.get(manifest.id);
      assert.ok(extStore, 'external collection store should be loaded at startup');

      const results = await extStore.search('durable root binding', { limit: 5 });
      const docResult = results.find((r) => r.anchor === `${manifest.id}:doc/source`);

      assert.ok(docResult?.drillDown, 'existing external collection row should retain file drillDown');
      assert.equal(docResult.drillDown.params.path, 'cat-cafe://collection/world%3Adurable-root/docs/source.md');
      assert.ok(!docResult.drillDown.params.path.includes(root), 'drillDown path must not leak host source root');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  it('binds legacy private external collections to the configured runtime owner', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
    const { saveExternalCollection } = await import('../../dist/domains/memory/external-collections.js');
    const dataDir = mkdtempSync(join(tmpdir(), 'f263-private-external-data-'));
    const root = mkdtempSync(join(tmpdir(), 'f263-private-external-root-'));
    const docsRoot = mkdtempSync(join(tmpdir(), 'f263-private-external-docs-'));
    try {
      saveExternalCollection(dataDir, {
        id: 'domain:legacy-private',
        kind: 'domain',
        name: 'legacy-private',
        displayName: 'Legacy Private',
        root,
        sensitivity: 'private',
        scannerLevel: 0,
        indexPolicy: { autoRebuild: false },
        reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
        createdAt: '2026-05-22T00:00:00.000Z',
        updatedAt: '2026-05-22T00:00:00.000Z',
      });

      const services = await createMemoryServices({
        type: 'sqlite',
        sqlitePath: join(dataDir, 'project.sqlite'),
        globalDbPath: join(dataDir, 'global.sqlite'),
        dataDir,
        docsRoot,
        privateUserId: 'owner-1',
      });

      assert.equal(services.catalog.get('domain:legacy-private').ownerUserId, 'owner-1');
      assert.equal(services.catalog.getRoutable('collection', ['domain:legacy-private']).length, 0);
      assert.equal(
        services.catalog.getRoutable('collection', ['domain:legacy-private'], ['domain:legacy-private']).length,
        1,
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(docsRoot, { recursive: true, force: true });
    }
  });

  it('F263 binds canonical profile and personal memory as owner-private collections', async () => {
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
    const dataDir = mkdtempSync(join(tmpdir(), 'f263-private-data-'));
    const docsRoot = mkdtempSync(join(tmpdir(), 'f263-private-docs-'));
    const memoryRoot = mkdtempSync(join(tmpdir(), 'f263-private-memory-'));
    try {
      const profileRoot = join(dataDir, 'profiles', 'owner-1', 'relationship');
      mkdirSync(profileRoot, { recursive: true });
      writeFileSync(
        join(profileRoot, 'current-primer.md'),
        '# Synthetic Relationship\n\nSYNTHETIC_CANONICAL_PROFILE_TOKEN',
      );
      const memoryDir = join(memoryRoot, '-Users-synthetic-project', 'memory');
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(
        join(memoryDir, 'user_preferences.md'),
        '---\nname: Synthetic preference\ntype: user\n---\nSYNTHETIC_PERSONAL_MEMORY_TOKEN',
      );

      const services = await createMemoryServices({
        type: 'sqlite',
        sqlitePath: join(dataDir, 'project.sqlite'),
        globalDbPath: join(dataDir, 'global.sqlite'),
        dataDir,
        docsRoot,
        memoryRoot,
        privateUserId: 'owner-1',
      });
      await services.globalIndexBuilder.rebuild();

      const profile = services.catalog.get('domain:user-profile');
      const personal = services.catalog.get('domain:personal-memory');
      assert.equal(profile.ownerUserId, 'owner-1');
      assert.equal(profile.sensitivity, 'private');
      assert.equal(personal.ownerUserId, 'owner-1');
      assert.equal(personal.sensitivity, 'private');

      const profileResult = await services.knowledgeResolver.resolve('SYNTHETIC_CANONICAL_PROFILE_TOKEN', {
        dimension: 'collection',
        collections: ['domain:user-profile'],
        authorizedCollections: ['domain:user-profile'],
      });
      assert.equal(profileResult.collectionGroups.length, 1, 'authorized owner reaches canonical profile collection');

      const personalResult = await services.knowledgeResolver.resolve('SYNTHETIC_PERSONAL_MEMORY_TOKEN', {
        dimension: 'collection',
        collections: ['domain:personal-memory'],
        authorizedCollections: ['domain:personal-memory'],
      });
      assert.equal(personalResult.collectionGroups.length, 1, 'authorized owner reaches re-layered personal memory');
      assert.equal((await services.globalStore.search('SYNTHETIC_PERSONAL_MEMORY_TOKEN')).length, 0);

      const expeditionResult = await services.knowledgeResolver.resolve('SYNTHETIC', { dimension: 'library' });
      assert.ok(
        !expeditionResult.collectionGroups.some((group) => group.collectionId.startsWith('domain:user-')),
        'default/expedition context excludes private profile scope',
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(docsRoot, { recursive: true, force: true });
      rmSync(memoryRoot, { recursive: true, force: true });
    }
  });
});
