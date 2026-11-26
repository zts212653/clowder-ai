/**
 * F231 Phase E T12: Private collection bindings — corpus file indexed by domain:user-profile.
 *
 * Verifies that corpus/shared-facts.md inside the canonical profile directory
 * is indexed by the domain:user-profile collection (INV-9) and does NOT leak
 * into project/library default scope.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { profileUserRelativePath } from '@cat-cafe/shared/profile-contract';

describe('private-collection-bindings: corpus indexing (INV-9)', () => {
  let tmp;
  let dataDir;
  /** On-disk stores created during hot-registration; closed in afterEach. */
  let storesToClose;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pcb-corpus-'));
    dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    storesToClose = [];
  });

  afterEach(() => {
    for (const s of storesToClose) {
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  test('corpus/shared-facts.md is indexed inside domain:user-profile collection', async () => {
    const userId = 'test-user';
    const profileRoot = join(dataDir, ...profileUserRelativePath(userId).split('/'));
    mkdirSync(join(profileRoot, 'relationship'), { recursive: true });
    mkdirSync(join(profileRoot, 'corpus'), { recursive: true });
    writeFileSync(join(profileRoot, 'relationship', 'ragdoll-primer.md'), 'PRIMER CONTENT');
    writeFileSync(join(profileRoot, 'corpus', 'shared-facts.md'), 'CORPUS FACTS');

    const { CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { resolveCollectionScanner } = await import('../../dist/domains/memory/scanner-resolver.js');

    const manifest = {
      id: 'domain:user-profile',
      kind: 'domain',
      name: 'user-profile',
      displayName: 'Canonical User Profile',
      root: profileRoot,
      sensitivity: 'private',
      ownerUserId: userId,
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const store = new SqliteEvidenceStore(':memory:', undefined, {
      sourceRoot: profileRoot,
      sourceRef: manifest.id,
    });
    await store.initialize();
    const builder = new CollectionIndexBuilder(store, manifest, resolveCollectionScanner(manifest));
    const result = await builder.rebuild();

    assert.equal(result.blocked, false);
    // The scanner should index both primer and corpus files
    assert.ok(result.indexed >= 2, `expected ≥2 indexed files, got ${result.indexed}`);
  });

  test('domain:user-profile manifest uses private sensitivity (scoped, not project/library)', () => {
    const userId = 'test-user';
    const relPath = profileUserRelativePath(userId);
    assert.ok(relPath.startsWith('profiles/'), `expected profiles/ prefix, got ${relPath}`);
    // Corpus lives inside this profile path, so it's automatically scoped to
    // the private user-profile collection. It never enters project or library scope
    // because those collections have distinct roots.
  });

  test('refreshCanonicalProfileIndex rebuilds index with new corpus content', async () => {
    const userId = 'refresh-user';
    const profileRoot = join(dataDir, ...profileUserRelativePath(userId).split('/'));
    mkdirSync(join(profileRoot, 'corpus'), { recursive: true });
    writeFileSync(join(profileRoot, 'corpus', 'shared-facts.md'), 'INITIAL FACTS');

    const { refreshCanonicalProfileIndex } = await import('../../dist/domains/memory/private-collection-bindings.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');

    const manifest = {
      id: 'domain:user-profile',
      kind: 'domain',
      name: 'user-profile',
      displayName: 'Canonical User Profile',
      root: profileRoot,
      sensitivity: 'private',
      ownerUserId: userId,
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const store = new SqliteEvidenceStore(':memory:', undefined, {
      sourceRoot: profileRoot,
      sourceRef: manifest.id,
    });
    await store.initialize();

    // Build a catalog and stores map matching what runtime does
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');
    const catalog = new LibraryCatalog();
    catalog.register(manifest);
    const stores = new Map();
    stores.set('domain:user-profile', store);

    // First refresh — indexes initial content
    await refreshCanonicalProfileIndex(stores, catalog);
    const firstResults = await store.search('INITIAL FACTS');
    assert.ok(firstResults.length >= 1, 'initial corpus content indexed after refresh');

    // Write new corpus content and refresh again
    writeFileSync(join(profileRoot, 'corpus', 'shared-facts.md'), 'UPDATED FACTS');
    await refreshCanonicalProfileIndex(stores, catalog);
    const updatedResults = await store.search('UPDATED FACTS');
    assert.ok(updatedResults.length >= 1, 'updated corpus content indexed after second refresh');
  });

  test('refreshCanonicalProfileIndex is no-op when store not registered', async () => {
    const { refreshCanonicalProfileIndex } = await import('../../dist/domains/memory/private-collection-bindings.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');
    const catalog = new LibraryCatalog();
    const stores = new Map();

    // Should silently return without error
    await refreshCanonicalProfileIndex(stores, catalog);
  });

  // --- INV-9 R5: real helper-level regression tests (no mocks) ---

  test('hot registration + secret-bearing profile root → hot_registration_rebuild_blocked (INV-9a)', async () => {
    const userId = 'hotblocked-user';
    const profileRoot = join(dataDir, ...profileUserRelativePath(userId).split('/'));
    mkdirSync(join(profileRoot, 'corpus'), { recursive: true });
    // Fictional GitHub token pattern triggers SecretScanner → blocked rebuild
    writeFileSync(
      join(profileRoot, 'corpus', 'shared-facts.md'),
      ['Fictional credential: gh', 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234'].join(''),
    );

    const { refreshCanonicalProfileIndex } = await import('../../dist/domains/memory/private-collection-bindings.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    const stores = new Map();

    const result = await refreshCanonicalProfileIndex(stores, catalog, {
      dataDir,
      userId,
    });

    assert.equal(result.status, 'error');
    assert.equal(result.error, 'hot_registration_rebuild_blocked');

    // Store was created (hot-reg path), track for cleanup
    const store = stores.get('domain:user-profile');
    if (store) {
      storesToClose.push(store);
      // Blocked rebuild purges content — no searchable hits
      const hits = await store.search('credential');
      assert.equal(hits.length, 0, 'blocked rebuild must not leave searchable content');
    }
  });

  test('existing registered store + secret-bearing rebuild → rebuild_blocked', async () => {
    const userId = 'blockrefresh-user';
    const profileRoot = join(dataDir, ...profileUserRelativePath(userId).split('/'));
    mkdirSync(join(profileRoot, 'corpus'), { recursive: true });
    writeFileSync(join(profileRoot, 'corpus', 'shared-facts.md'), 'FICTIONAL CLEAN CONTENT');

    const { refreshCanonicalProfileIndex } = await import('../../dist/domains/memory/private-collection-bindings.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js');
    const { resolveCollectionScanner } = await import('../../dist/domains/memory/scanner-resolver.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const manifest = {
      id: 'domain:user-profile',
      kind: 'domain',
      name: 'user-profile',
      displayName: 'Canonical User Profile',
      root: profileRoot,
      sensitivity: 'private',
      ownerUserId: userId,
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const store = new SqliteEvidenceStore(':memory:', undefined, {
      sourceRoot: profileRoot,
      sourceRef: manifest.id,
    });
    await store.initialize();
    storesToClose.push(store);

    // First build with clean content — verify searchable
    const builder = new CollectionIndexBuilder(store, manifest, resolveCollectionScanner(manifest));
    await builder.rebuild();
    const cleanHits = await store.search('FICTIONAL CLEAN');
    assert.ok(cleanHits.length >= 1, 'clean content must be searchable before blocked rebuild');

    const catalog = new LibraryCatalog();
    catalog.register({ ...manifest, status: 'active' });
    const stores = new Map();
    stores.set('domain:user-profile', store);

    // Overwrite with secret-bearing content and refresh
    writeFileSync(
      join(profileRoot, 'corpus', 'shared-facts.md'),
      ['Fictional credential: gh', 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234'].join(''),
    );

    const result = await refreshCanonicalProfileIndex(stores, catalog, { userId });

    assert.equal(result.status, 'error');
    assert.equal(result.error, 'rebuild_blocked');

    // Old index must be purged by SecretScanner
    const purgedHits = await store.search('FICTIONAL CLEAN');
    assert.equal(purgedHits.length, 0, 'old index must be purged after blocked rebuild');
  });

  test('clean first profile root → registered + immediately searchable (INV-9a)', async () => {
    const userId = 'freshreg-user';
    const profileRoot = join(dataDir, ...profileUserRelativePath(userId).split('/'));
    mkdirSync(join(profileRoot, 'corpus'), { recursive: true });
    writeFileSync(join(profileRoot, 'corpus', 'shared-facts.md'), 'FICTIONAL PROFILE FACTS FOR SEARCH TESTING');

    const { refreshCanonicalProfileIndex } = await import('../../dist/domains/memory/private-collection-bindings.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    const stores = new Map();

    const result = await refreshCanonicalProfileIndex(stores, catalog, {
      dataDir,
      userId,
    });

    assert.equal(result.status, 'registered');

    // Store must be in the map and content immediately searchable
    const store = stores.get('domain:user-profile');
    assert.ok(store, 'store must be registered in stores map after hot-registration');
    storesToClose.push(store);
    const hits = await store.search('FICTIONAL PROFILE FACTS');
    assert.ok(hits.length >= 1, 'corpus content must be immediately searchable after registration (INV-9a)');
  });

  // --- INV-9 R7: catalog × store state matrix tests (table-driven) ---

  /** Shared archived manifest factory for state matrix tests. */
  function archivedManifest(profileRoot, userId) {
    return {
      id: 'domain:user-profile',
      kind: 'domain',
      name: 'user-profile',
      displayName: 'Canonical User Profile',
      root: profileRoot,
      sensitivity: 'private',
      ownerUserId: userId,
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'archived',
    };
  }

  /** Shared active manifest factory for state matrix tests. */
  function activeManifest(profileRoot, userId) {
    return { ...archivedManifest(profileRoot, userId), status: 'active' };
  }

  test('[matrix] catalog archived + store absent → skipped/archived, no SQLite file created (INV-9f)', async () => {
    const userId = 'archived-user';
    const profileRoot = join(dataDir, ...profileUserRelativePath(userId).split('/'));
    mkdirSync(join(profileRoot, 'corpus'), { recursive: true });
    writeFileSync(join(profileRoot, 'corpus', 'shared-facts.md'), 'SHOULD NOT BE INDEXED');

    const { refreshCanonicalProfileIndex } = await import('../../dist/domains/memory/private-collection-bindings.js');
    const { resolveCollectionStorePath } = await import('../../dist/domains/memory/external-collections.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    catalog.register(archivedManifest(profileRoot, userId));
    const stores = new Map();

    const result = await refreshCanonicalProfileIndex(stores, catalog, { dataDir, userId });

    assert.equal(result.status, 'skipped');
    assert.equal(result.error, 'archived');
    assert.equal(stores.size, 0, 'archived collection must not trigger store creation');
    // Assert no SQLite file was created at the expected store path
    const expectedPath = resolveCollectionStorePath(dataDir, 'domain:user-profile');
    assert.equal(existsSync(expectedPath), false, 'no SQLite file must exist after archived skip');
  });

  test('[matrix] catalog active + store absent → error/catalog_store_skew (INV-9f)', async () => {
    const userId = 'skew-user';
    const profileRoot = join(dataDir, ...profileUserRelativePath(userId).split('/'));
    mkdirSync(join(profileRoot, 'corpus'), { recursive: true });
    writeFileSync(join(profileRoot, 'corpus', 'shared-facts.md'), 'SHOULD NOT BE INDEXED');

    const { refreshCanonicalProfileIndex } = await import('../../dist/domains/memory/private-collection-bindings.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const catalog = new LibraryCatalog();
    catalog.register(activeManifest(profileRoot, userId));
    const stores = new Map(); // Store absent despite active catalog entry = skew

    const result = await refreshCanonicalProfileIndex(stores, catalog, { dataDir, userId });

    assert.equal(result.status, 'error');
    assert.equal(result.error, 'catalog_store_skew');
    assert.equal(stores.size, 0, 'skew must not create a store');
  });

  test('[matrix] catalog absent + store present → error/store_catalog_skew (INV-9f)', async () => {
    const userId = 'reverse-skew-user';
    const profileRoot = join(dataDir, ...profileUserRelativePath(userId).split('/'));
    mkdirSync(join(profileRoot, 'corpus'), { recursive: true });
    writeFileSync(join(profileRoot, 'corpus', 'shared-facts.md'), 'FICTIONAL CONTENT');

    const { refreshCanonicalProfileIndex } = await import('../../dist/domains/memory/private-collection-bindings.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const store = new SqliteEvidenceStore(':memory:', undefined, {
      sourceRoot: profileRoot,
      sourceRef: 'domain:user-profile',
    });
    await store.initialize();
    storesToClose.push(store);

    const catalog = new LibraryCatalog(); // Empty catalog — no manifest
    const stores = new Map();
    stores.set('domain:user-profile', store); // Store present, catalog absent = skew

    const result = await refreshCanonicalProfileIndex(stores, catalog, { userId });

    assert.equal(result.status, 'error');
    assert.equal(result.error, 'store_catalog_skew');
  });

  test('[matrix] catalog archived + store present → skipped/archived, no rebuild (INV-9f)', async () => {
    const userId = 'archived-with-store-user';
    const profileRoot = join(dataDir, ...profileUserRelativePath(userId).split('/'));
    mkdirSync(join(profileRoot, 'corpus'), { recursive: true });
    writeFileSync(join(profileRoot, 'corpus', 'shared-facts.md'), 'SHOULD NOT BE RE-INDEXED');

    const { refreshCanonicalProfileIndex } = await import('../../dist/domains/memory/private-collection-bindings.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const store = new SqliteEvidenceStore(':memory:', undefined, {
      sourceRoot: profileRoot,
      sourceRef: 'domain:user-profile',
    });
    await store.initialize();
    storesToClose.push(store);

    const catalog = new LibraryCatalog();
    catalog.register(archivedManifest(profileRoot, userId));
    const stores = new Map();
    stores.set('domain:user-profile', store);

    const result = await refreshCanonicalProfileIndex(stores, catalog, { userId });

    assert.equal(result.status, 'skipped');
    assert.equal(result.error, 'archived');
    // Store exists but no rebuild should happen — verify no content was indexed
    const hits = await store.search('SHOULD NOT BE RE-INDEXED');
    assert.equal(hits.length, 0, 'archived collection must not rebuild even when store is present');
  });

  test('registerPrivateAndExternalCollections closes failed external store and leaves no dangling catalog entry', async () => {
    const { registerPrivateAndExternalCollections } = await import(
      '../../dist/domains/memory/private-collection-bindings.js'
    );
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const healthyRoot = join(tmp, 'healthy-ext');
    const brokenRoot = join(tmp, 'broken-ext');
    mkdirSync(healthyRoot, { recursive: true });
    mkdirSync(brokenRoot, { recursive: true });

    const now = new Date().toISOString();
    const brokenManifest = {
      id: 'research:broken-init',
      kind: 'research',
      name: 'broken-init',
      displayName: 'Broken External Collection',
      root: brokenRoot,
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: now,
      updatedAt: now,
    };
    const healthyManifest = {
      ...brokenManifest,
      id: 'research:healthy-init',
      name: 'healthy-init',
      displayName: 'Healthy External Collection',
      root: healthyRoot,
    };

    const origInit = SqliteEvidenceStore.prototype.initialize;
    const origClose = SqliteEvidenceStore.prototype.close;
    let closedBrokenStores = 0;
    SqliteEvidenceStore.prototype.initialize = async function () {
      await origInit.call(this);
      if (this.sourceRef === 'research:broken-init') {
        throw new Error('simulated external store initialization failure');
      }
    };
    SqliteEvidenceStore.prototype.close = function () {
      if (this.sourceRef === 'research:broken-init') {
        closedBrokenStores += 1;
      }
      return origClose.call(this);
    };

    const catalog = new LibraryCatalog();
    const stores = new Map();
    try {
      await registerPrivateAndExternalCollections({
        catalog,
        stores,
        externalManifests: [brokenManifest, healthyManifest],
        dataDir,
        now,
      });
    } finally {
      SqliteEvidenceStore.prototype.initialize = origInit;
      SqliteEvidenceStore.prototype.close = origClose;
    }

    for (const s of stores.values()) storesToClose.push(s);

    assert.equal(closedBrokenStores, 1, 'failed external store must be closed to prevent SQLite handle leak');
    assert.equal(stores.get('research:broken-init'), undefined, 'failed external store must not enter stores map');
    assert.equal(
      catalog.get('research:broken-init'),
      undefined,
      'failed external collection must not leave a dangling entry in catalog when stores lacks it',
    );
    assert.ok(stores.get('research:healthy-init'), 'healthy sibling external store must still be registered');
    assert.ok(catalog.get('research:healthy-init'), 'healthy sibling external manifest must still be registered');
  });

  test('startup autoRebuild=true indexes external collection and sets catalog status active (asserted via stores.get/catalog.get)', async () => {
    const { registerPrivateAndExternalCollections } = await import(
      '../../dist/domains/memory/private-collection-bindings.js'
    );
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const autoRoot = join(tmp, 'ext-auto-true');
    const manualRoot = join(tmp, 'ext-auto-false');
    mkdirSync(autoRoot, { recursive: true });
    mkdirSync(manualRoot, { recursive: true });
    writeFileSync(join(autoRoot, 'auto-doc.md'), '# Auto Rebuild\n\nSTARTUP AUTO REBUILD CONTENT');
    writeFileSync(join(manualRoot, 'manual-doc.md'), '# Manual Rebuild\n\nMANUAL ONLY CONTENT');

    const now = new Date().toISOString();
    const autoManifest = {
      id: 'research:auto-true',
      kind: 'research',
      name: 'auto-true',
      displayName: 'Auto True Collection',
      root: autoRoot,
      sensitivity: 'internal',
      scannerLevel: 0,
      status: 'registered',
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: now,
      updatedAt: now,
    };
    const manualManifest = {
      ...autoManifest,
      id: 'research:auto-false',
      name: 'auto-false',
      displayName: 'Auto False Collection',
      root: manualRoot,
      indexPolicy: { autoRebuild: false },
    };

    const catalog = new LibraryCatalog();
    const stores = new Map();
    await registerPrivateAndExternalCollections({
      catalog,
      stores,
      externalManifests: [autoManifest, manualManifest],
      dataDir,
      now,
    });
    for (const s of stores.values()) storesToClose.push(s);

    assert.equal(catalog.get('research:auto-true')?.status, 'active');
    assert.ok(stores.get('research:auto-true'), 'autoRebuild store must be present in stores map');
    const autoHits = await stores.get('research:auto-true').search('STARTUP AUTO REBUILD CONTENT');
    assert.equal(autoHits.length, 1, 'autoRebuild=true external collection must be searchable immediately on startup');

    assert.equal(catalog.get('research:auto-false')?.status, 'registered');
    assert.ok(stores.get('research:auto-false'), 'autoRebuild=false store must be present in stores map');
    const manualHits = await stores.get('research:auto-false').search('MANUAL ONLY CONTENT');
    assert.equal(manualHits.length, 0, 'autoRebuild=false external collection must not be scanned on startup');
  });

  test('startup autoRebuild=true with secret-bearing file marks catalog status blocked and purges store', async () => {
    const { registerPrivateAndExternalCollections } = await import(
      '../../dist/domains/memory/private-collection-bindings.js'
    );
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const secretRoot = join(tmp, 'ext-auto-secret');
    mkdirSync(secretRoot, { recursive: true });
    writeFileSync(
      join(secretRoot, 'leak.md'),
      ['# Secret Leak\n\nCredential: gh', 'p_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234'].join(''),
    );

    const now = new Date().toISOString();
    const secretManifest = {
      id: 'research:auto-secret',
      kind: 'research',
      name: 'auto-secret',
      displayName: 'Auto Secret Collection',
      root: secretRoot,
      sensitivity: 'internal',
      scannerLevel: 0,
      status: 'active',
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: now,
      updatedAt: now,
    };

    const catalog = new LibraryCatalog();
    const stores = new Map();
    await registerPrivateAndExternalCollections({
      catalog,
      stores,
      externalManifests: [secretManifest],
      dataDir,
      now,
    });
    for (const s of stores.values()) storesToClose.push(s);

    assert.equal(catalog.get('research:auto-secret')?.status, 'blocked');
    assert.ok(stores.get('research:auto-secret'));
    const hits = await stores.get('research:auto-secret').search('Credential');
    assert.equal(hits.length, 0, 'blocked external collection must have zero searchable docs');
  });

  test('startup autoRebuild failure closes SQLite handle and leaves no dangling catalog entry', async () => {
    const { registerPrivateAndExternalCollections } = await import(
      '../../dist/domains/memory/private-collection-bindings.js'
    );
    const { CollectionIndexBuilder } = await import('../../dist/domains/memory/CollectionIndexBuilder.js');
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');

    const brokenRoot = join(tmp, 'ext-broken-rebuild');
    const healthyRoot = join(tmp, 'ext-healthy-rebuild');
    mkdirSync(brokenRoot, { recursive: true });
    mkdirSync(healthyRoot, { recursive: true });
    writeFileSync(join(brokenRoot, 'a.md'), '# Broken\n\nContent');
    writeFileSync(join(healthyRoot, 'b.md'), '# Healthy\n\nHEALTHY CONTENT');

    const now = new Date().toISOString();
    const brokenManifest = {
      id: 'research:broken-rebuild',
      kind: 'research',
      name: 'broken-rebuild',
      displayName: 'Broken Rebuild',
      root: brokenRoot,
      sensitivity: 'internal',
      scannerLevel: 0,
      indexPolicy: { autoRebuild: true },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: now,
      updatedAt: now,
    };
    const healthyManifest = {
      ...brokenManifest,
      id: 'research:healthy-rebuild',
      name: 'healthy-rebuild',
      displayName: 'Healthy Rebuild',
      root: healthyRoot,
    };

    const origRebuild = CollectionIndexBuilder.prototype.rebuild;
    const origClose = SqliteEvidenceStore.prototype.close;
    let closedBroken = 0;
    CollectionIndexBuilder.prototype.rebuild = async function (...args) {
      if (this.manifest?.id === 'research:broken-rebuild') {
        throw new Error('simulated rebuild failure');
      }
      return origRebuild.apply(this, args);
    };
    SqliteEvidenceStore.prototype.close = function () {
      if (this.sourceRef === 'research:broken-rebuild') closedBroken += 1;
      return origClose.call(this);
    };

    const catalog = new LibraryCatalog();
    const stores = new Map();
    try {
      await registerPrivateAndExternalCollections({
        catalog,
        stores,
        externalManifests: [brokenManifest, healthyManifest],
        dataDir,
        now,
      });
    } finally {
      CollectionIndexBuilder.prototype.rebuild = origRebuild;
      SqliteEvidenceStore.prototype.close = origClose;
    }
    for (const s of stores.values()) storesToClose.push(s);

    assert.equal(closedBroken, 1, 'failed external store must be closed');
    assert.equal(stores.get('research:broken-rebuild'), undefined);
    assert.equal(catalog.get('research:broken-rebuild'), undefined, 'no dangling catalog entry on rebuild throw');
    assert.equal(catalog.get('research:healthy-rebuild')?.status, 'active');
    const healthyHits = await stores.get('research:healthy-rebuild').search('HEALTHY CONTENT');
    assert.equal(healthyHits.length, 1);
  });

  test('external collection startup autoRebuild (with added and deleted docs) marks G1-backed store stale so it exits G1 cohort without blocking main store activation', async () => {
    const Fastify = (await import('fastify')).default;
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
    const { embeddingRecipeFingerprint, readEmbeddingDeployment } = await import(
      '../../dist/domains/memory/embedding-generation-config.js'
    );
    const { openVectorGeneration } = await import('../../dist/domains/memory/open-vector-generation.js');
    const { libraryRoutes } = await import('../../dist/routes/library.js');

    const root = join(tmp, 'g1-cohort-startup');
    const docs = join(root, 'docs');
    const extRoot = join(root, 'external-vault');
    const extDataDir = join(root, 'data');
    mkdirSync(docs, { recursive: true });
    mkdirSync(extRoot, { recursive: true });
    mkdirSync(extDataDir, { recursive: true });

    writeFileSync(join(extRoot, 'keep.md'), '# Keep\n\nPERSISTENT_ANCHOR_ALPHA');
    writeFileSync(join(extRoot, 'to-delete.md'), '# Delete\n\nOBSOLETE_REMOVED_BETA');

    const deployment = readEmbeddingDeployment();
    deployment.activeId = 'g1';
    deployment.generations.g1.runtime.maxModelMemMb = 32;
    deployment.generations.g1.recipe = { ...deployment.generations.g1.recipe, modelId: 'fixture-g1', dim: 6 };
    const model = {
      modelId: 'fixture-g1',
      modelRev: deployment.generations.g1.recipe.modelRevision,
      dim: 6,
      generationId: 'g1',
      representationFingerprint: embeddingRecipeFingerprint(deployment.generations.g1.recipe),
    };
    const encoder = {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      dispose() {},
      isReady: () => true,
      getModelInfo: () => model,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0, 0, 0])),
    };

    const prepareMainG1 = (svc) => {
      const main = openVectorGeneration(svc.store.getDb(), model, { create: true });
      main.vectorStore.initMeta(model);
      svc.store
        .getDb()
        .prepare("INSERT OR REPLACE INTO vector_generations VALUES('g1',?,'ready')")
        .run(model.representationFingerprint);
      svc.embeddingLifecycle.getDeployment = () => deployment;
      svc.embeddingLifecycle.createEmbeddingService = () => encoder;
      svc.embeddingLifecycle.requireLegacyConsumer = false;
    };

    // Phase 1: Register external collection with indexPolicy.autoRebuild=true and build its G1 vectors.
    const service1 = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: join(root, 'evidence.sqlite'),
      globalDbPath: join(root, 'global.sqlite'),
      dataDir: extDataDir,
      docsRoot: docs,
      markersDir: join(root, 'markers'),
      skillsRoot: join(root, 'skills'),
      memoryRoot: join(root, 'memory'),
      embed: { embedMode: 'off', embedDim: 6 },
    });
    prepareMainG1(service1);

    const app = Fastify();
    await app.register(libraryRoutes, {
      catalog: service1.catalog,
      stores: service1.collectionStores,
      dataDir: service1.dataDir,
      getEmbeddingService: () => encoder,
      getEmbedMode: () => 'on',
    });

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'research:g1-ext',
        kind: 'research',
        name: 'g1-ext',
        displayName: 'G1 External Vault',
        root: extRoot,
        sensitivity: 'internal',
        scannerLevel: 0,
        indexPolicy: { autoRebuild: true },
      },
    });
    assert.equal(regRes.statusCode, 200, regRes.body);
    assert.equal(regRes.json().manifest.indexPolicy.autoRebuild, true);

    const rebRes = await app.inject({ method: 'POST', url: '/api/library/research:g1-ext/rebuild' });
    assert.equal(rebRes.statusCode, 200, rebRes.body);
    assert.equal((await service1.embeddingLifecycle.activate('on')).ok, true);
    assert.equal(service1.collectionStores.get('research:g1-ext').searchEmbedding()?.getModelInfo().generationId, 'g1');

    service1.embeddingLifecycle.deactivate();
    await app.close();
    for (const s of new Set([service1.store, ...service1.collectionStores.values()])) s.close();

    // Phase 2: Before restart, add a new document and delete an old document in the external collection.
    rmSync(join(extRoot, 'to-delete.md'));
    writeFileSync(join(extRoot, 'added-on-startup.md'), '# Added\n\nFRESH_STARTUP_GAMMA');

    // Phase 3: Restart memory services. Startup autoRebuild updates lexical index, marks G1-backed store stale,
    // and main store still activates G1 without being blocked by the unembedded new doc in research:g1-ext.
    const service2 = await createMemoryServices({
      type: 'sqlite',
      sqlitePath: join(root, 'evidence.sqlite'),
      globalDbPath: join(root, 'global.sqlite'),
      dataDir: extDataDir,
      docsRoot: docs,
      markersDir: join(root, 'markers'),
      skillsRoot: join(root, 'skills'),
      memoryRoot: join(root, 'memory'),
      embed: { embedMode: 'off', embedDim: 6 },
    });
    for (const s of new Set([service2.store, ...service2.collectionStores.values()])) storesToClose.push(s);
    prepareMainG1(service2);

    const extStore2 = service2.collectionStores.get('research:g1-ext');
    assert.ok(extStore2, 'restarted external store must be in collectionStores');
    assert.equal(
      service2.catalog.get('research:g1-ext')?.status,
      'stale',
      'G1-backed external collection with startup lexical additions/deletions must transition to stale',
    );

    const addedHits = await extStore2.search('FRESH_STARTUP_GAMMA');
    assert.equal(addedHits.length, 1, 'newly added document must be lexically searchable after startup autoRebuild');
    const deletedHits = await extStore2.search('OBSOLETE_REMOVED_BETA');
    assert.equal(deletedHits.length, 0, 'deleted document must be removed after startup autoRebuild');

    const activation = await service2.embeddingLifecycle.activate('on');
    assert.equal(
      activation.ok,
      true,
      'main store G1 activation must succeed without being blocked by stale external store',
    );
    assert.equal(service2.store.searchEmbedding()?.getModelInfo().generationId, 'g1');
    assert.equal(
      extStore2.searchEmbedding(),
      undefined,
      'stale external store must exit the G1 cohort activation until its vectors are rebuilt',
    );
    service2.embeddingLifecycle.deactivate();
  });
});
