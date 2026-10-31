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
    try {
      await registerCanonicalProfile({ catalog, stores, dataDir, privateUserId, now });
    } catch {
      // fail-open at startup: private profile remains unavailable rather than crashing the server.
      // Hot-registration during approve surfaces errors via ProfileCollectionRefreshResult (INV-9).
    }
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

/**
 * Result of refreshCanonicalProfileIndex — typed, never swallowed.
 *
 * State machine (≥3-轮 R3 design, INV-9):
 *   absent ──[approve writes profile root]──→ registered (hot-registration + rebuild)
 *   active ──[approve writes new content]──→ refreshed (rebuild on existing store)
 *   *      ──[error]──→ { status: 'error', error: message }
 *   *      ──[owner mismatch / no dataDir]──→ skipped
 */
export interface ProfileCollectionRefreshResult {
  status: 'refreshed' | 'registered' | 'skipped' | 'error';
  error?: string;
}

/** Extract a displayable error message from an unknown thrown value. */
function errorMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a hot-registration result to a typed ProfileCollectionRefreshResult. */
function mapRegistrationResult(regResult: CanonicalProfileRegistrationResult | null): ProfileCollectionRefreshResult {
  if (regResult === null) return { status: 'skipped', error: 'hot_registration_no_profile_root' };
  if (regResult.blocked) return { status: 'error', error: 'hot_registration_rebuild_blocked' };
  return { status: 'registered' };
}

/**
 * Phase E (INV-9): refresh the canonical profile collection index after approve writes new content.
 *
 * INV-9f (R7): catalog × store state matrix checked **before** any store construction or I/O.
 * Decision lives here; `registerCanonicalProfile` means only actual first-time registration.
 *
 * Owner boundary (INV-9b): if `options.userId` is provided and the registered manifest belongs
 * to a different user, returns `skipped` with `owner_mismatch` — user A's approve never
 * refreshes user B's collection.
 */
export async function refreshCanonicalProfileIndex(
  stores: Map<string, IEvidenceStore>,
  catalog: LibraryCatalog,
  options?: { dataDir?: string; userId?: string },
): Promise<ProfileCollectionRefreshResult> {
  const store = stores.get('domain:user-profile') as SqliteEvidenceStore | undefined;
  const manifest = catalog.get('domain:user-profile');

  // INV-9f (R7): catalog × store state matrix — all skew/archived decisions before any I/O.
  if (manifest?.status === 'archived') return { status: 'skipped', error: 'archived' };
  if (!store && manifest) return { status: 'error', error: 'catalog_store_skew' };
  if (store && !manifest) return { status: 'error', error: 'store_catalog_skew' };

  // Hot registration: catalog absent + store absent + eligible
  if (!store && options?.dataDir && options?.userId) {
    return hotRegister(catalog, stores, options.dataDir, options.userId);
  }

  if (!store) return { status: 'skipped', error: 'not_registered' };
  // Redundant guard for TypeScript narrowing — the state matrix above guarantees
  // manifest is defined when store is defined (store && !manifest returned error).
  if (!manifest) return { status: 'error', error: 'store_catalog_skew' };

  // Normal refresh: store present + manifest present + non-archived
  if (options?.userId && manifest.ownerUserId && manifest.ownerUserId !== options.userId) {
    return { status: 'skipped', error: 'owner_mismatch' };
  }

  try {
    const scanner = resolveCollectionScanner(manifest);
    const builder = new CollectionIndexBuilder(store, manifest, scanner);
    const result = await builder.rebuild();
    if (result.blocked) return { status: 'error', error: 'rebuild_blocked' };
    return { status: 'refreshed' };
  } catch (err) {
    return { status: 'error', error: `rebuild_failed: ${errorMsg(err)}` };
  }
}

/** Hot-registration wrapper — keeps `refreshCanonicalProfileIndex` under cognitive complexity cap. */
async function hotRegister(
  catalog: LibraryCatalog,
  stores: Map<string, IEvidenceStore>,
  dataDir: string,
  userId: string,
): Promise<ProfileCollectionRefreshResult> {
  let regResult: CanonicalProfileRegistrationResult | null;
  try {
    regResult = await registerCanonicalProfile({
      catalog,
      stores,
      dataDir,
      privateUserId: userId,
      now: new Date().toISOString(),
    });
  } catch (err) {
    return { status: 'error', error: `hot_registration_failed: ${errorMsg(err)}` };
  }
  return mapRegistrationResult(regResult);
}

/**
 * Result of a hot-registration attempt.
 * `null` = profile root doesn't exist (nothing to register).
 * INV-9f (R7): catalog/store skew decisions moved to caller; this function only does actual registration.
 */
interface CanonicalProfileRegistrationResult {
  blocked: boolean;
}

async function registerCanonicalProfile(options: {
  catalog: LibraryCatalog;
  stores: Map<string, IEvidenceStore>;
  dataDir: string;
  privateUserId: string;
  now: string;
}): Promise<CanonicalProfileRegistrationResult | null> {
  const profileRoot = join(options.dataDir, ...profileUserRelativePath(options.privateUserId).split('/'));
  if (!existsSync(profileRoot)) return null;

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
  // INV-9a/c (R4): errors propagate to caller — never swallowed.
  // The outer refreshCanonicalProfileIndex wraps all paths in typed results.
  const profilePath = resolveCollectionStorePath(options.dataDir, manifest.id);
  mkdirSync(dirname(profilePath), { recursive: true });
  const store = new SqliteEvidenceStore(profilePath, undefined, {
    sourceRoot: profileRoot,
    sourceRef: manifest.id,
  });
  try {
    await store.initialize();
    const builder = new CollectionIndexBuilder(store, manifest, resolveCollectionScanner(manifest));
    const result = await builder.rebuild();
    options.catalog.register({ ...manifest, status: result.blocked ? 'blocked' : 'active' });
    options.stores.set(manifest.id, store);
    return { blocked: result.blocked };
  } catch (err) {
    // INV-9 R5: close SQLite handle when any step after store construction
    // fails (e.g. catalog.register throws on duplicate manifest).
    // Without this, the handle leaks because the store never enters the map.
    store.close();
    throw err;
  }
}
