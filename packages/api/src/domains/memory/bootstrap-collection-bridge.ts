import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { type CollectionEmbedDeps, CollectionIndexBuilder } from './CollectionIndexBuilder.js';
import type { CollectionManifest } from './collection-types.js';
import { resolveCollectionStorePath, saveExternalCollection } from './external-collections.js';
import type { IEmbeddingService, IEvidenceStore } from './interfaces.js';
import type { LibraryCatalog } from './LibraryCatalog.js';
import { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { resolveCollectionScanner } from './scanner-resolver.js';
import { ensureVectorTable } from './schema.js';
import { VectorStore } from './VectorStore.js';

function deriveCollectionId(projectPath: string): string {
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
  getEmbeddingService?: () => IEmbeddingService | undefined,
): Promise<{ docsIndexed: number; durationMs: number }> {
  const startMs = Date.now();
  const collectionId = deriveCollectionId(projectPath);

  let manifest = catalog.get(collectionId);
  let store = stores.get(collectionId) as SqliteEvidenceStore | undefined;

  if (!manifest) {
    const now = new Date().toISOString();
    manifest = {
      id: collectionId,
      kind: 'project',
      name: collectionId.replace('project:', ''),
      displayName: basename(projectPath),
      root: projectPath,
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
  store.setSourceRoot(manifest.root, manifest.id);

  let embedDeps: CollectionEmbedDeps | undefined;
  const embeddingService = getEmbeddingService?.();
  if (embeddingService) {
    try {
      const db = store.getDb();
      const sqliteVecMod = await import('sqlite-vec');
      sqliteVecMod.load(db);
      const dim = embeddingService.getModelInfo().dim;
      if (ensureVectorTable(db, dim)) {
        embedDeps = {
          getEmbeddingService: () => (getEmbeddingService?.() === embeddingService ? embeddingService : undefined),
          vectorStore: new VectorStore(db, dim),
        };
      }
    } catch {
      // fail-open: sqlite-vec not available → FTS-only
    }
  }

  const scanner = resolveCollectionScanner(manifest);
  const builder = new CollectionIndexBuilder(store, manifest, scanner, embedDeps);
  const result = await builder.rebuild();

  if (result.blocked) {
    throw new Error(`Collection ${collectionId} blocked: ${result.secretFindings.length} secret(s) detected — purged`);
  }

  return { docsIndexed: result.indexed + result.skipped, durationMs: Date.now() - startMs };
}
