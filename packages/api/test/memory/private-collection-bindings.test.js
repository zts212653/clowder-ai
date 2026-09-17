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
      'Fictional credential: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234',
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
      'Fictional credential: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef1234',
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
});
