import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { profileUserRelativePath } from '@cat-cafe/shared/profile-contract';
import { CollectionIndexBuilder } from './CollectionIndexBuilder.js';
import type { CollectionManifest } from './collection-types.js';
import { resolveCollectionStorePath } from './external-collections.js';
import type { IEvidenceStore } from './interfaces.js';
import type { LibraryCatalog } from './LibraryCatalog.js';
import { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { resolveCollectionScanner } from './scanner-resolver.js';

interface PersonalStoreOptions {
  dataDir: string;
  globalPath: string;
  memoryRoot?: string;
  privateUserId?: string;
}

export async function createPersonalMemoryStore(
  options: PersonalStoreOptions,
): Promise<SqliteEvidenceStore | undefined> {
  if (!options.privateUserId) return undefined;
  try {
    const memoryRoot = options.memoryRoot ?? join(homedir(), '.claude', 'projects');
    const personalPath =
      options.globalPath === ':memory:'
        ? ':memory:'
        : resolveCollectionStorePath(options.dataDir, 'domain:personal-memory');
    mkdirSync(dirname(personalPath), { recursive: true });
    const store = new SqliteEvidenceStore(personalPath, undefined, {
      sourceRoot: memoryRoot,
      sourceRef: 'domain:personal-memory',
    });
    await store.initialize();
    return store;
  } catch {
    // Keep the W5 global purge path available even when private projection setup fails.
    return undefined;
  }
}

interface PrivateBindingsOptions {
  catalog: LibraryCatalog;
  stores: Map<string, IEvidenceStore>;
  externalManifests: CollectionManifest[];
  dataDir: string;
  memoryRoot?: string;
  privateUserId?: string;
  personalStore?: SqliteEvidenceStore;
  now: string;
}

export async function registerPrivateAndExternalCollections(options: PrivateBindingsOptions): Promise<void> {
  const { catalog, stores, dataDir, privateUserId, personalStore, now } = options;
  if (personalStore && privateUserId) {
    catalog.register({
      id: 'domain:personal-memory',
      kind: 'domain',
      name: 'personal-memory',
      displayName: 'Personal Local Memory',
      root: options.memoryRoot ?? join(homedir(), '.claude', 'projects'),
      sensitivity: 'private',
      ownerUserId: privateUserId,
      scannerLevel: 0,
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      createdAt: now,
      updatedAt: now,
    });
    stores.set('domain:personal-memory', personalStore);
  }

  if (privateUserId) {
    await registerCanonicalProfile({ catalog, stores, dataDir, privateUserId, now });
  }

  for (const externalManifest of options.externalManifests) {
    try {
      const manifest = bindLegacyPrivateOwner(externalManifest, privateUserId);
      catalog.register(manifest);
      if (manifest.status === 'archived') continue;
      const storePath = resolveCollectionStorePath(dataDir, manifest.id);
      mkdirSync(dirname(storePath), { recursive: true });
      const store = new SqliteEvidenceStore(storePath, undefined, {
        sourceRoot: manifest.root,
        sourceRef: manifest.id,
      });
      await store.initialize();
      stores.set(manifest.id, store);
    } catch {
      // fail-open: skip broken external collections
    }
  }
}

function bindLegacyPrivateOwner(manifest: CollectionManifest, privateUserId?: string): CollectionManifest {
  if (
    privateUserId &&
    manifest.ownerUserId == null &&
    (manifest.sensitivity === 'private' || manifest.sensitivity === 'restricted')
  ) {
    return { ...manifest, ownerUserId: privateUserId };
  }
  return manifest;
}

async function registerCanonicalProfile(options: {
  catalog: LibraryCatalog;
  stores: Map<string, IEvidenceStore>;
  dataDir: string;
  privateUserId: string;
  now: string;
}): Promise<void> {
  const profileRoot = join(options.dataDir, ...profileUserRelativePath(options.privateUserId).split('/'));
  if (!existsSync(profileRoot)) return;

  const manifest: CollectionManifest = {
    id: 'domain:user-profile',
    kind: 'domain',
    name: 'user-profile',
    displayName: 'Canonical User Profile',
    root: profileRoot,
    sensitivity: 'private',
    ownerUserId: options.privateUserId,
    scannerLevel: 0,
    indexPolicy: { autoRebuild: true },
    reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
    createdAt: options.now,
    updatedAt: options.now,
  };
  try {
    const profilePath = resolveCollectionStorePath(options.dataDir, manifest.id);
    mkdirSync(dirname(profilePath), { recursive: true });
    const store = new SqliteEvidenceStore(profilePath, undefined, {
      sourceRoot: profileRoot,
      sourceRef: manifest.id,
    });
    await store.initialize();
    const builder = new CollectionIndexBuilder(store, manifest, resolveCollectionScanner(manifest));
    const result = await builder.rebuild();
    options.catalog.register({ ...manifest, status: result.blocked ? 'blocked' : 'active' });
    options.stores.set(manifest.id, store);
  } catch {
    // fail-open for public/project memory; private profile remains unavailable rather than misrouted.
  }
}
