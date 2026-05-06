import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { BindingDryRun } from '../domains/memory/BindingDryRun.js';
import { CollectionIndexBuilder } from '../domains/memory/CollectionIndexBuilder.js';
import { CollectionReadModel } from '../domains/memory/CollectionReadModel.js';
import type { CollectionKind, CollectionManifest, CollectionSensitivity } from '../domains/memory/collection-types.js';
import { validateManifestInput } from '../domains/memory/collection-types.js';
import { resolveCollectionStorePath, saveExternalCollection } from '../domains/memory/external-collections.js';
import { GraphResolver } from '../domains/memory/GraphResolver.js';
import type { IEvidenceStore } from '../domains/memory/interfaces.js';
import type { LibraryCatalog } from '../domains/memory/LibraryCatalog.js';
import { SqliteEvidenceStore } from '../domains/memory/SqliteEvidenceStore.js';
import { resolveCollectionScanner } from '../domains/memory/scanner-resolver.js';

export interface LibraryRoutesOptions {
  catalog: LibraryCatalog;
  stores: Map<string, IEvidenceStore>;
  dataDir?: string;
}

type StoreWithDb = IEvidenceStore & { getDb?: () => import('better-sqlite3').Database };
type StoreWithGetRelated = IEvidenceStore & import('../domains/memory/GraphResolver.js').GraphStore;

export const libraryRoutes: FastifyPluginAsync<LibraryRoutesOptions> = async (app, opts) => {
  app.get('/api/library/catalog', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const collections = opts.catalog.list();
    const items = collections.map((manifest) => {
      const store = opts.stores.get(manifest.id) as StoreWithDb | undefined;
      const db = store?.getDb?.();
      return {
        manifest,
        overview: db
          ? CollectionReadModel.computeOverview(manifest.id, manifest.displayName, manifest.sensitivity, db)
          : null,
        health: db ? CollectionReadModel.computeHealth(manifest.id, db) : null,
      };
    });
    return { collections: items };
  });

  app.get<{ Params: { collectionId: string } }>('/api/library/:collectionId', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const { collectionId } = request.params;
    const manifest = opts.catalog.get(collectionId);
    if (!manifest) {
      reply.status(404);
      return { error: `Collection "${collectionId}" not found` };
    }
    const store = opts.stores.get(manifest.id) as StoreWithDb | undefined;
    const db = store?.getDb?.();
    return {
      manifest,
      overview: db
        ? CollectionReadModel.computeOverview(manifest.id, manifest.displayName, manifest.sensitivity, db)
        : null,
      health: db ? CollectionReadModel.computeHealth(manifest.id, db) : null,
    };
  });

  app.post('/api/library/register', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const body = request.body as {
      id: string;
      kind: string;
      name: string;
      displayName: string;
      root: string;
      sensitivity?: string;
      scannerLevel?: number | 'auto';
      exclude?: string[];
    };

    try {
      validateManifestInput(body);
    } catch (e: unknown) {
      reply.status(400);
      return { error: (e as Error).message };
    }

    if (opts.catalog.get(body.id)) {
      reply.status(409);
      return { error: `Collection "${body.id}" already exists` };
    }

    const now = new Date().toISOString();
    const manifest: CollectionManifest = {
      id: body.id,
      kind: body.kind as CollectionKind,
      name: body.name,
      displayName: body.displayName,
      root: body.root,
      sensitivity: (body.sensitivity ?? 'private') as CollectionSensitivity,
      scannerLevel: (body.scannerLevel ?? 'auto') as CollectionManifest['scannerLevel'],
      indexPolicy: { autoRebuild: false },
      reviewPolicy: { authorityCeiling: 'validated', requireOwnerApproval: true },
      exclude: body.exclude,
      createdAt: now,
      updatedAt: now,
    };

    const dataDir = opts.dataDir;
    if (dataDir) saveExternalCollection(dataDir, manifest);

    opts.catalog.register(manifest);
    const storePath = dataDir
      ? resolveCollectionStorePath(dataDir, manifest.id)
      : resolveCollectionStorePath('/tmp/cat-cafe-dev', manifest.id);
    mkdirSync(dirname(storePath), { recursive: true });
    const store = new SqliteEvidenceStore(storePath);
    await store.initialize();
    opts.stores.set(manifest.id, store);
    return { manifest };
  });

  app.get<{ Params: { collectionId: string } }>('/api/library/:collectionId/documents', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const { collectionId } = request.params;
    const manifest = opts.catalog.get(collectionId);
    if (!manifest) {
      reply.status(404);
      return { error: `Collection "${collectionId}" not found` };
    }
    const store = opts.stores.get(manifest.id) as StoreWithDb | undefined;
    const db = store?.getDb?.();
    if (!db) {
      return { collectionId, groups: [] };
    }
    const groups = CollectionReadModel.computeDocumentGroups(collectionId, db);
    return { collectionId, groups };
  });

  app.post<{ Params: { collectionId: string } }>('/api/library/:collectionId/rebuild', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const manifest = opts.catalog.get(request.params.collectionId);
    if (!manifest) {
      reply.status(404);
      return { error: 'Collection not found' };
    }
    const store = opts.stores.get(manifest.id);
    if (!store) {
      reply.status(404);
      return { error: 'Store not found' };
    }
    const scanner = resolveCollectionScanner(manifest);
    const builder = new CollectionIndexBuilder(store as SqliteEvidenceStore, manifest, scanner);
    const result = await builder.rebuild();
    return result;
  });

  app.post('/api/library/bind-dry-run', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const body = request.body as { root?: unknown; exclude?: unknown; authorityCeiling?: unknown } | undefined;
    if (!body || typeof body !== 'object' || typeof body.root !== 'string' || !body.root) {
      reply.status(400);
      return { error: 'root is required and must be a non-empty string' };
    }
    if (body.exclude !== undefined) {
      if (!Array.isArray(body.exclude) || !body.exclude.every((e: unknown) => typeof e === 'string')) {
        reply.status(400);
        return { error: 'exclude must be a string array' };
      }
    }
    let stat;
    try {
      stat = statSync(body.root, { throwIfNoEntry: false });
    } catch {
      reply.status(400);
      return { error: `Root path is not a valid directory: ${body.root}` };
    }
    if (!stat?.isDirectory()) {
      reply.status(400);
      return { error: `Root path is not a valid directory: ${body.root}` };
    }
    const ceiling = typeof body.authorityCeiling === 'string' ? body.authorityCeiling : undefined;
    return BindingDryRun.run(body.root, { exclude: body.exclude as string[], authorityCeiling: ceiling });
  });

  app.get('/api/library/graph', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const qs = request.query as { anchor?: string; depth?: string; collections?: string };
    if (!qs.anchor) {
      reply.status(400);
      return { error: 'anchor query parameter is required' };
    }
    const depth = qs.depth ? Number.parseInt(qs.depth, 10) : 1;
    if (Number.isNaN(depth) || depth < 0 || depth > 3) {
      reply.status(400);
      return { error: 'depth must be 0-3' };
    }
    const callerCollections = qs.collections?.split(',').filter(Boolean);
    const graphStores = new Map<string, StoreWithGetRelated>();
    for (const [id, s] of opts.stores) {
      if ('getRelated' in s) graphStores.set(id, s as StoreWithGetRelated);
    }
    const resolver = new GraphResolver(opts.catalog, graphStores);
    return resolver.buildSubgraph(qs.anchor, { depth, callerCollections });
  });
};
