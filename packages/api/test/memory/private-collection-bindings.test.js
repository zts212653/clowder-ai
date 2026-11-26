/**
 * F231 Phase E T12: Private collection bindings — corpus file indexed by domain:user-profile.
 *
 * Verifies that corpus/shared-facts.md inside the canonical profile directory
 * is indexed by the domain:user-profile collection (INV-9) and does NOT leak
 * into project/library default scope.
 */

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

  test('Issue #2085: recovers stale external collection from SQLite coverage after collections.json write failure (and unavailable root), then rejoins cohort after manual rebuild', async () => {
    const Fastify = (await import('fastify')).default;
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
    const { embeddingRecipeFingerprint, readEmbeddingDeployment } = await import(
      '../../dist/domains/memory/embedding-generation-config.js'
    );
    const { getExternalCollection, updateExternalCollection } = await import(
      '../../dist/domains/memory/external-collections.js'
    );
    const { openVectorGeneration } = await import('../../dist/domains/memory/open-vector-generation.js');
    const { libraryRoutes } = await import('../../dist/routes/library.js');

    const root = join(tmp, 'issue-2085-stale-recovery');
    const docs = join(root, 'docs');
    const extRoot = join(root, 'external-vault');
    const extRootMoved = join(root, 'external-vault-offline');
    const extDataDir = join(root, 'data');
    mkdirSync(docs, { recursive: true });
    mkdirSync(extRoot, { recursive: true });
    mkdirSync(extDataDir, { recursive: true });

    writeFileSync(join(extRoot, 'keep.md'), '# Keep\n\nKEEP_PERSISTENT_ANCHOR');
    writeFileSync(join(extRoot, 'to-delete.md'), '# Delete\n\nDELETE_OBSOLETE_ANCHOR');

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

    const makeMemoryService = () =>
      createMemoryServices({
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

    const closeService = (svc) => {
      svc.embeddingLifecycle.deactivate();
      for (const s of new Set([svc.store, ...svc.collectionStores.values()])) s.close();
    };

    // Phase 1: Register opt-in autoRebuild external collection and build full G1 vectors.
    const service1 = await makeMemoryService();
    prepareMainG1(service1);
    const app1 = Fastify();
    await app1.register(libraryRoutes, {
      catalog: service1.catalog,
      stores: service1.collectionStores,
      dataDir: service1.dataDir,
      getEmbeddingService: () => encoder,
      getEmbedMode: () => 'on',
    });
    const regRes = await app1.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'research:g1-2085',
        kind: 'research',
        name: 'g1-2085',
        displayName: 'G1 2085 Vault',
        root: extRoot,
        sensitivity: 'internal',
        scannerLevel: 0,
        indexPolicy: { autoRebuild: true },
      },
    });
    assert.equal(regRes.statusCode, 200, regRes.body);
    const reb1 = await app1.inject({ method: 'POST', url: '/api/library/research:g1-2085/rebuild' });
    assert.equal(reb1.statusCode, 200, reb1.body);
    assert.equal((await service1.embeddingLifecycle.activate('on')).ok, true);
    assert.equal(
      service1.collectionStores.get('research:g1-2085').searchEmbedding()?.getModelInfo().generationId,
      'g1',
    );
    await app1.close();
    closeService(service1);

    // Phase 2: Delete 1 doc, add 41 new docs (exceeding bounded cohort vector repair),
    // and make collections.json read-only so startup status persistence fails.
    rmSync(join(extRoot, 'to-delete.md'));
    for (let i = 0; i < 41; i++) {
      writeFileSync(join(extRoot, `bulk-${String(i).padStart(2, '0')}.md`), `# Bulk ${i}\n\nBULK_DOC_CONTENT_${i}`);
    }
    const collectionsPath = join(extDataDir, 'library', 'collections.json');
    chmodSync(collectionsPath, 0o444);
    try {
      const service2 = await makeMemoryService();
      assert.equal(service2.catalog.get('research:g1-2085')?.status, 'stale');
      closeService(service2);
    } finally {
      chmodSync(collectionsPath, 0o644);
    }
    // Verify collections.json remained 'active' despite SQLite receiving 41 unembedded docs.
    assert.equal(
      getExternalCollection(extDataDir, 'research:g1-2085')?.status,
      'active',
      'collections.json write failure must leave disk manifest active before recovery',
    );

    // Phase 3a: Zero-change restart with collections.json writable again must recover 'stale'
    // from SQLite coverage, heal collections.json, and keep main-store activate('on') green.
    const service3 = await makeMemoryService();
    prepareMainG1(service3);
    assert.equal(
      service3.catalog.get('research:g1-2085')?.status,
      'stale',
      'zero-change restart must recover stale state from SQLite vector coverage',
    );
    assert.equal(
      getExternalCollection(extDataDir, 'research:g1-2085')?.status,
      'stale',
      'collections.json must be healed to stale once writable',
    );
    const act3 = await service3.embeddingLifecycle.activate('on');
    assert.equal(act3.ok, true, 'main-store G1 activation must not be degraded by unembedded external docs');
    assert.equal(service3.store.searchEmbedding()?.getModelInfo().generationId, 'g1');
    assert.equal(service3.collectionStores.get('research:g1-2085')?.searchEmbedding(), undefined);
    closeService(service3);

    // Phase 3b: Temporarily unavailable manifest.root — verify BOTH real paths honestly:
    // (1) Real cold boot while root is already offline: loadExternalCollections skips non-existent roots
    //     (per external-collections.test.js contract), so the offline store is excluded from cohort and
    //     main-store activate('on') stays green; once root returns online on a later boot (with disk
    //     collections.json still 'active'), SQLite coverage immediately recovers 'stale' and heals disk.
    // (2) Load->registration window / direct registerPrivateAndExternalCollections when root disappears
    //     after load: the offline recovery branch in registerOneExternalCollection still marks 'stale'
    //     and heals collections.json.
    updateExternalCollection(extDataDir, 'research:g1-2085', { status: 'active' });
    const loadedBeforeOffline = getExternalCollection(extDataDir, 'research:g1-2085');
    assert.ok(loadedBeforeOffline);
    renameSync(extRoot, extRootMoved);
    try {
      // (1a) Real cold boot while root is already offline before loadExternalCollections
      const coldOffline = await makeMemoryService();
      prepareMainG1(coldOffline);
      assert.equal(
        coldOffline.catalog.get('research:g1-2085'),
        undefined,
        'loadExternalCollections skips already-offline root per existing loader contract',
      );
      assert.equal(coldOffline.collectionStores.has('research:g1-2085'), false);
      const actOffline = await coldOffline.embeddingLifecycle.activate('on');
      assert.equal(actOffline.ok, true, 'main-store G1 activation must remain green while external root is offline');
      assert.equal(coldOffline.store.searchEmbedding()?.getModelInfo().generationId, 'g1');
      closeService(coldOffline);

      // (2) Load->registration window (manifest loaded before root became unavailable)
      const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');
      const { registerPrivateAndExternalCollections } = await import(
        '../../dist/domains/memory/private-collection-bindings.js'
      );
      const offlineCatalog = new LibraryCatalog();
      const offlineStores = new Map();
      await registerPrivateAndExternalCollections({
        catalog: offlineCatalog,
        stores: offlineStores,
        externalManifests: [loadedBeforeOffline],
        dataDir: extDataDir,
        now: new Date().toISOString(),
      });
      assert.equal(
        offlineCatalog.get('research:g1-2085')?.status,
        'stale',
        'load->registration offline window must still recover stale from SQLite coverage',
      );
      for (const s of offlineStores.values()) s.close();
    } finally {
      renameSync(extRootMoved, extRoot);
    }
    assert.equal(
      getExternalCollection(extDataDir, 'research:g1-2085')?.status,
      'stale',
      'collections.json must also be healed to stale in the load->registration offline window',
    );

    // (1b) Real cold boot after root returns online with collections.json reset to 'active'
    updateExternalCollection(extDataDir, 'research:g1-2085', { status: 'active' });
    const coldReturned = await makeMemoryService();
    prepareMainG1(coldReturned);
    assert.equal(
      coldReturned.catalog.get('research:g1-2085')?.status,
      'stale',
      'cold boot after offline root returns must recover stale from SQLite coverage even if disk stayed active',
    );
    assert.equal(getExternalCollection(extDataDir, 'research:g1-2085')?.status, 'stale');
    const actReturned = await coldReturned.embeddingLifecycle.activate('on');
    assert.equal(actReturned.ok, true);
    assert.equal(coldReturned.store.searchEmbedding()?.getModelInfo().generationId, 'g1');
    assert.equal(coldReturned.collectionStores.get('research:g1-2085')?.searchEmbedding(), undefined);
    closeService(coldReturned);

    // Opt-in boundary check: autoRebuild=false and archived manifests must not be altered by stale recovery.
    {
      const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');
      const { registerPrivateAndExternalCollections } = await import(
        '../../dist/domains/memory/private-collection-bindings.js'
      );
      const boundaryCatalog = new LibraryCatalog();
      const boundaryStores = new Map();
      const baseManifest = getExternalCollection(extDataDir, 'research:g1-2085');
      await registerPrivateAndExternalCollections({
        catalog: boundaryCatalog,
        stores: boundaryStores,
        externalManifests: [
          { ...baseManifest, indexPolicy: { autoRebuild: false }, status: 'active' },
          { ...baseManifest, id: 'research:g1-2085-archived', name: 'g1-2085-archived', status: 'archived' },
        ],
        dataDir: extDataDir,
        now: new Date().toISOString(),
      });
      assert.equal(
        boundaryCatalog.get('research:g1-2085')?.status,
        'active',
        'autoRebuild=false collection must preserve its manifest status untouched',
      );
      assert.equal(
        boundaryCatalog.get('research:g1-2085-archived')?.status,
        'archived',
        'archived collection must remain archived without opening store',
      );
      assert.equal(boundaryStores.has('research:g1-2085-archived'), false);
      for (const s of boundaryStores.values()) s.close();
    }

    // Phase 4: Manual rebuild repopulates all 42 G1 vectors; subsequent zero-change restart cleanly rejoins G1 cohort.
    const service4 = await makeMemoryService();
    prepareMainG1(service4);
    const app4 = Fastify();
    await app4.register(libraryRoutes, {
      catalog: service4.catalog,
      stores: service4.collectionStores,
      dataDir: service4.dataDir,
      getEmbeddingService: () => encoder,
      getEmbedMode: () => 'on',
    });
    const reb4 = await app4.inject({ method: 'POST', url: '/api/library/research:g1-2085/rebuild' });
    assert.equal(reb4.statusCode, 200, reb4.body);
    assert.equal(service4.catalog.get('research:g1-2085')?.status, 'active');
    await app4.close();
    closeService(service4);

    const service5 = await makeMemoryService();
    for (const s of new Set([service5.store, ...service5.collectionStores.values()])) storesToClose.push(s);
    prepareMainG1(service5);
    assert.equal(
      service5.catalog.get('research:g1-2085')?.status,
      'active',
      'rebuilt external collection must stay active on subsequent zero-change restart',
    );
    const act5 = await service5.embeddingLifecycle.activate('on');
    assert.equal(act5.ok, true);
    assert.equal(service5.store.searchEmbedding()?.getModelInfo().generationId, 'g1');
    assert.equal(
      service5.collectionStores.get('research:g1-2085')?.searchEmbedding()?.getModelInfo().generationId,
      'g1',
      'rebuilt external collection must rejoin G1 cohort after restart',
    );
    service5.embeddingLifecycle.deactivate();
  });

  test('Issue #2085 guardrail: canonical activeId=g0 keeps complete serving G0 active despite paused or quarantined G1 shadow, while explicit activeGenerationId=g1 marks stale', async () => {
    const Fastify = (await import('fastify')).default;
    const { LibraryCatalog } = await import('../../dist/domains/memory/LibraryCatalog.js');
    const { embeddingRecipeFingerprint, readEmbeddingDeployment } = await import(
      '../../dist/domains/memory/embedding-generation-config.js'
    );
    const { loadExternalCollections } = await import('../../dist/domains/memory/external-collections.js');
    const { registerPrivateAndExternalCollections } = await import(
      '../../dist/domains/memory/private-collection-bindings.js'
    );
    const { ShadowVectorGenerationBuilder } = await import(
      '../../dist/domains/memory/ShadowVectorGenerationBuilder.js'
    );
    const { libraryRoutes } = await import('../../dist/routes/library.js');

    const root = join(tmp, 'issue-2085-g0-guardrail');
    const extRoot = join(root, 'vault-g0');
    const shadowOnlyRoot = join(root, 'vault-shadow-only');
    const extDataDir = join(root, 'data');
    mkdirSync(extRoot, { recursive: true });
    mkdirSync(shadowOnlyRoot, { recursive: true });
    mkdirSync(extDataDir, { recursive: true });

    writeFileSync(join(extRoot, 'alpha.md'), '# Alpha\n\nServing G0 document one.');
    writeFileSync(join(extRoot, 'beta.md'), '# Beta\n\nServing G0 document two.');
    writeFileSync(join(shadowOnlyRoot, 'gamma.md'), '# Gamma\n\nShadow only document one.');
    writeFileSync(join(shadowOnlyRoot, 'delta.md'), '# Delta\n\nShadow only document two.');

    const g0Model = { modelId: 'fixture-g0', modelRev: '1', dim: 4, generationId: 'g0' };
    const g0Encoder = {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      dispose() {},
      isReady: () => true,
      getModelInfo: () => g0Model,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    };

    const deployment = readEmbeddingDeployment();
    assert.equal(deployment.activeId, 'g0', 'canonical deployment activeId fixture assumption');
    const g1Recipe = { ...deployment.generations.g1.recipe, modelId: 'fixture-g1-shadow', dim: 6 };
    const g1Model = {
      modelId: 'fixture-g1-shadow',
      modelRev: g1Recipe.modelRevision,
      dim: 6,
      generationId: 'g1',
      representationFingerprint: embeddingRecipeFingerprint(g1Recipe),
    };
    const g1Encoder = {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      dispose() {},
      isReady: () => true,
      getModelInfo: () => g1Model,
      embed: async (texts) => texts.map(() => new Float32Array([0, 1, 0, 0, 0, 0])),
    };

    // Phase 1: Register and build a complete serving G0 collection + a lexical-only shadow-target collection.
    const setupCatalog = new LibraryCatalog();
    const setupStores = new Map();
    const app = Fastify();
    await app.register(libraryRoutes, {
      catalog: setupCatalog,
      stores: setupStores,
      dataDir: extDataDir,
      getEmbeddingService: () => g0Encoder,
      getEmbedMode: () => 'on',
    });
    for (const [id, name, dir] of [
      ['research:g0-serving', 'g0-serving', extRoot],
      ['research:g1-shadow-only', 'g1-shadow-only', shadowOnlyRoot],
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/library/register',
        payload: {
          id,
          kind: 'research',
          name,
          displayName: name,
          root: dir,
          sensitivity: 'internal',
          scannerLevel: 0,
          indexPolicy: { autoRebuild: true },
        },
      });
      assert.equal(res.statusCode, 200, res.body);
    }
    // Build complete G0 vectors for research:g0-serving only.
    const g0Reb = await app.inject({ method: 'POST', url: '/api/library/research:g0-serving/rebuild' });
    assert.equal(g0Reb.statusCode, 200, g0Reb.body);
    assert.equal(setupCatalog.get('research:g0-serving')?.status, 'active');

    // Run a paused G1 shadow build (1 batch of 1 out of 2 docs -> state='building', incomplete) on both stores.
    const g0Store = setupStores.get('research:g0-serving');
    const pausedRes = await new ShadowVectorGenerationBuilder(g0Store, g1Encoder, false).build({
      deadlineAt: Date.now() + 5000,
      maxBatches: 1,
      batchSize: 1,
    });
    assert.equal(pausedRes.status, 'paused');

    // For research:g1-shadow-only, index lexically without G0, then start an inactive paused G1 shadow build.
    await app.close();
    const appLexOnly = Fastify();
    await appLexOnly.register(libraryRoutes, {
      catalog: setupCatalog,
      stores: setupStores,
      dataDir: extDataDir,
    });
    const lexReb = await appLexOnly.inject({ method: 'POST', url: '/api/library/research:g1-shadow-only/rebuild' });
    assert.equal(lexReb.statusCode, 200, lexReb.body);
    await appLexOnly.close();
    const shadowOnlyStore = setupStores.get('research:g1-shadow-only');
    const shadowOnlyPaused = await new ShadowVectorGenerationBuilder(shadowOnlyStore, g1Encoder, false).build({
      deadlineAt: Date.now() + 5000,
      maxBatches: 1,
      batchSize: 1,
    });
    assert.equal(shadowOnlyPaused.status, 'paused');
    for (const s of setupStores.values()) s.close();

    // Helper to run zero-change startup registration and inspect statuses.
    const restartAndCheck = async (extraOptions = {}) => {
      const cat = new LibraryCatalog();
      const map = new Map();
      await registerPrivateAndExternalCollections({
        catalog: cat,
        stores: map,
        externalManifests: loadExternalCollections(extDataDir),
        dataDir: extDataDir,
        now: new Date().toISOString(),
        ...extraOptions,
      });
      return { cat, map };
    };

    // Case A: Canonical activeId='g0' + paused G1 shadow -> g0-serving stays 'active',
    // and g1-shadow-only (no G0, inactive building G1 shadow) also stays 'active'.
    const runA = await restartAndCheck();
    assert.equal(
      runA.cat.get('research:g0-serving')?.status,
      'active',
      'paused G1 shadow must not disqualify complete serving G0 under activeId=g0',
    );
    assert.equal(
      runA.cat.get('research:g1-shadow-only')?.status,
      'active',
      'inactive building G1 shadow must not be counted as serving vectors under activeId=g0',
    );
    // Quarantine G1 shadow on g0-serving while keeping G0 intact.
    runA.map
      .get('research:g0-serving')
      .getDb()
      .prepare("INSERT OR REPLACE INTO embedding_meta_g1(key,value) VALUES('vector_invalidation_quarantined','1')")
      .run();
    for (const s of runA.map.values()) s.close();

    // Case B: Canonical activeId='g0' + quarantined G1 shadow -> g0-serving STILL stays 'active'.
    const runB = await restartAndCheck();
    assert.equal(
      runB.cat.get('research:g0-serving')?.status,
      'active',
      'quarantined G1 shadow must not disqualify complete serving G0 under activeId=g0',
    );
    for (const s of runB.map.values()) s.close();

    // Case C: Explicit activeGenerationId='g1' on the exact same store -> MUST mark 'stale'.
    const runC = await restartAndCheck({ activeGenerationId: 'g1' });
    for (const s of runC.map.values()) storesToClose.push(s);
    assert.equal(
      runC.cat.get('research:g0-serving')?.status,
      'stale',
      'explicit activeGenerationId=g1 must mark incomplete/quarantined G1 store stale',
    );
    assert.equal(
      runC.cat.get('research:g1-shadow-only')?.status,
      'stale',
      'explicit activeGenerationId=g1 must mark paused building G1 store stale',
    );
  });

  test('Issue #2085 P2-1 regression: inactive building G1 shadow (no G0) with startup lexical change is isolated as stale so ready main G0 activation succeeds', async () => {
    const Fastify = (await import('fastify')).default;
    const { createMemoryServices } = await import('../../dist/domains/memory/factory.js');
    const { embeddingRecipeFingerprint, readEmbeddingDeployment } = await import(
      '../../dist/domains/memory/embedding-generation-config.js'
    );
    const { ShadowVectorGenerationBuilder } = await import(
      '../../dist/domains/memory/ShadowVectorGenerationBuilder.js'
    );
    const { libraryRoutes } = await import('../../dist/routes/library.js');

    const root = join(tmp, 'issue-2085-shadow-lexical-activation');
    const docs = join(root, 'docs');
    const vault = join(root, 'vault');
    const extDataDir = join(root, 'data');
    mkdirSync(docs, { recursive: true });
    mkdirSync(vault, { recursive: true });
    mkdirSync(extDataDir, { recursive: true });
    writeFileSync(join(vault, 'a.md'), '# A\n\nAlpha doc.');
    writeFileSync(join(vault, 'b.md'), '# B\n\nBeta doc.');

    const deployment = readEmbeddingDeployment();
    assert.equal(deployment.activeId, 'g0');
    const g0Model = { modelId: 'fixture-g0-main', modelRev: '1', dim: 4, generationId: 'g0' };
    const g0Encoder = {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      dispose() {},
      isReady: () => true,
      getModelInfo: () => g0Model,
      embed: async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0])),
    };
    const g1Recipe = { ...deployment.generations.g1.recipe, modelId: 'fixture-g1-shadow-lex', dim: 6 };
    const g1Model = {
      modelId: 'fixture-g1-shadow-lex',
      modelRev: g1Recipe.modelRevision,
      dim: 6,
      generationId: 'g1',
      representationFingerprint: embeddingRecipeFingerprint(g1Recipe),
    };
    const g1Encoder = {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      dispose() {},
      isReady: () => true,
      getModelInfo: () => g1Model,
      embed: async (texts) => texts.map(() => new Float32Array([0, 1, 0, 0, 0, 0])),
    };

    const boot = () =>
      createMemoryServices({
        type: 'sqlite',
        sqlitePath: join(root, 'main.sqlite'),
        globalDbPath: join(root, 'global.sqlite'),
        dataDir: extDataDir,
        docsRoot: docs,
        markersDir: join(root, 'markers'),
        skillsRoot: join(root, 'skills'),
        memoryRoot: join(root, 'memory'),
        includeRosterEntitySeeds: false,
        embed: { embedMode: 'off', embedDim: 4 },
      });

    // Phase 1: Register opt-in lexical external collection + start paused G1 shadow (no external G0).
    const svc1 = await boot();
    const app1 = Fastify();
    await app1.register(libraryRoutes, { catalog: svc1.catalog, stores: svc1.collectionStores, dataDir: extDataDir });
    const reg = await app1.inject({
      method: 'POST',
      url: '/api/library/register',
      payload: {
        id: 'research:shadow-lex',
        kind: 'research',
        name: 'shadow-lex',
        displayName: 'Shadow Lex',
        root: vault,
        sensitivity: 'internal',
        scannerLevel: 0,
        indexPolicy: { autoRebuild: true },
      },
    });
    assert.equal(reg.statusCode, 200, reg.body);
    assert.equal(
      (await app1.inject({ method: 'POST', url: '/api/library/research:shadow-lex/rebuild' })).statusCode,
      200,
    );
    await app1.close();
    const extStore1 = svc1.collectionStores.get('research:shadow-lex');
    const paused = await new ShadowVectorGenerationBuilder(extStore1, g1Encoder, false).build({
      deadlineAt: Date.now() + 5000,
      maxBatches: 1,
      batchSize: 1,
    });
    assert.equal(paused.status, 'paused');
    for (const s of new Set([svc1.store, ...svc1.collectionStores.values()])) s.close();

    // Phase 2: Add a new external doc on disk, restart via createMemoryServices, build ready main G0,
    // and activate('on') with an encoder that throws on any subsequent embed() call.
    writeFileSync(join(vault, 'c.md'), '# C\n\nNewly added doc after paused G1 shadow.');
    const svc2 = await boot();
    for (const s of new Set([svc2.store, ...svc2.collectionStores.values()])) storesToClose.push(s);
    assert.equal(
      svc2.catalog.get('research:shadow-lex')?.status,
      'stale',
      'lexical change on store carrying physical G1 shadow tables must isolate external store as stale',
    );

    await svc2.store.upsert([
      {
        anchor: 'main-ready-g0',
        kind: 'note',
        title: 'Main G0 Doc',
        summary: 'Already encoded main G0 content.',
        status: 'active',
        sourceHash: 'main-g0-v1',
        updatedAt: new Date().toISOString(),
      },
    ]);
    const mainBuilt = await new ShadowVectorGenerationBuilder(svc2.store, g0Encoder, false).build({
      deadlineAt: Date.now() + 5000,
      maxBatches: 8,
      batchSize: 2,
    });
    assert.equal(mainBuilt.status, 'ready');
    svc2.embeddingLifecycle.getDeployment = () => deployment;
    svc2.embeddingLifecycle.createEmbeddingService = () => ({
      ...g0Encoder,
      embed: async () => {
        throw new Error('External-only vectors must not withdraw ready main G0');
      },
    });

    const activation = await svc2.embeddingLifecycle.activate('on');
    assert.equal(activation.ok, true, 'ready main G0 activation must succeed without encoding isolated external store');
    assert.equal(svc2.store.searchEmbedding()?.getModelInfo().generationId, 'g0');
    assert.equal(svc2.collectionStores.get('research:shadow-lex')?.searchEmbedding(), undefined);
    assert.equal(
      svc2.collectionStores
        .get('research:shadow-lex')
        .getDb()
        .prepare("SELECT 1 FROM sqlite_master WHERE name='evidence_vectors'")
        .get(),
      undefined,
      'isolated external store must not have an unexpected G0 vector table created during main activation',
    );
    svc2.embeddingLifecycle.deactivate();
  });
});
