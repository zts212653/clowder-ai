import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { CollectionIndexBuilder, type CollectionRebuildResult } from './CollectionIndexBuilder.js';
import type { CollectionManifest } from './collection-types.js';
import { prepareCollectionVectorBinding } from './collection-vector-binding.js';
import {
  getExternalCollection,
  resolveCollectionStorePath,
  saveExternalCollection,
  updateExternalCollection,
} from './external-collections.js';
import type { IEmbeddingService, IEvidenceStore } from './interfaces.js';
import type { LibraryCatalog } from './LibraryCatalog.js';
import { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { resolveCollectionScanner } from './scanner-resolver.js';

export function deriveProjectCollectionId(projectPath: string): string {
  let name = basename(projectPath)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  if (!name || !/^[a-z]/.test(name)) name = `p${name}`;
  const pathHash = createHash('sha256').update(resolve(projectPath)).digest('hex').slice(0, 8);
  return `project:${name}-${pathHash}`;
}

export async function ensureProjectCollection(
  projectPath: string,
  catalog: LibraryCatalog,
  stores: Map<string, IEvidenceStore>,
  dataDir: string,
  ownerUserId: string,
  getEmbeddingService?: () => IEmbeddingService | undefined,
): Promise<{ docsIndexed: number; durationMs: number }> {
  const owner = ownerUserId?.trim();
  if (!owner) throw new Error('project_collection_owner_required');
  const startMs = Date.now();
  const collectionId = deriveProjectCollectionId(projectPath);

  let manifest = catalog.get(collectionId);
  let store = stores.get(collectionId) as SqliteEvidenceStore | undefined;

  // Startup may project a legacy owner for reads without persisting that binding.
  // A project rebuild must honor the saved owner as well as the current catalog.
  const persistedManifest = getExternalCollection(dataDir, collectionId);
  for (const existing of [persistedManifest, manifest]) {
    if (!existing) continue;
    if (!existing.ownerUserId) throw new Error('project_collection_owner_unbound');
    if (existing.ownerUserId !== owner) throw new Error('project_collection_owner_mismatch');
  }

  // An unavailable project may have been omitted from the startup catalog.
  // Its saved policy and identity still describe an existing collection.
  manifest ??= persistedManifest;

  if (!manifest) {
    const now = new Date().toISOString();
    manifest = {
      id: collectionId,
      kind: 'project',
      name: collectionId.replace('project:', ''),
      displayName: basename(projectPath),
      root: projectPath,
      ownerUserId: owner,
      sensitivity: 'private',
      scannerLevel: 'auto',
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'candidate', requireOwnerApproval: false },
      createdAt: now,
      updatedAt: now,
    } satisfies CollectionManifest;

    const storePath = resolveCollectionStorePath(dataDir, collectionId);
    mkdirSync(dirname(storePath), { recursive: true });
    store = new SqliteEvidenceStore(storePath, undefined, { sourceRoot: manifest.root, sourceRef: manifest.id });
    await store.initialize();

    catalog.register(manifest);
    stores.set(collectionId, store);
    saveExternalCollection(dataDir, manifest);
  }

  if (!store) {
    const storePath = resolveCollectionStorePath(dataDir, collectionId);
    store = new SqliteEvidenceStore(storePath, undefined, { sourceRoot: manifest.root, sourceRef: manifest.id });
    await store.initialize();
    stores.set(collectionId, store);
  }
  if (!catalog.get(collectionId)) catalog.register(manifest);
  store.setSourceRoot(manifest.root, manifest.id);

  if (manifest.status === 'archived') throw new Error('project_collection_archived');
  let prepared: Awaited<ReturnType<typeof prepareCollectionVectorBinding>>;
  let vectorAttempted = false;
  const setStatus = (status: 'indexing' | 'blocked' | 'stale' | 'active') => {
    catalog.setStatus(collectionId, status);
    updateExternalCollection(dataDir, collectionId, { status });
  };
  store.setEmbedDeps(undefined);
  setStatus('indexing');
  let result: CollectionRebuildResult;
  try {
    const currentStore = store;
    const scanner = resolveCollectionScanner(manifest);
    const builder = new CollectionIndexBuilder(store, manifest, scanner, async () => {
      if (!getEmbeddingService?.()?.isReady()) return;
      vectorAttempted = true;
      prepared = await prepareCollectionVectorBinding(currentStore, () => getEmbeddingService?.());
      return prepared?.deps;
    });
    result = await builder.rebuild();
    const published = !result.blocked && prepared?.publish();
    setStatus(result.blocked ? 'blocked' : vectorAttempted && !published ? 'stale' : 'active');
  } catch (error) {
    store.setEmbedDeps(undefined);
    setStatus('blocked');
    throw error;
  }
  if (result.blocked)
    throw new Error(`Collection ${collectionId} blocked: ${result.secretFindings.length} secret(s) detected — purged`);

  return { docsIndexed: result.indexed + result.skipped, durationMs: Date.now() - startMs };
}
