import { mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { ToolEventLog } from '../domains/cats/services/tool-usage/ToolEventLog.js';
import { BindingDryRun } from '../domains/memory/BindingDryRun.js';
import type { CollectionEmbedDeps } from '../domains/memory/CollectionIndexBuilder.js';
import { CollectionIndexBuilder } from '../domains/memory/CollectionIndexBuilder.js';
import { CollectionReadModel } from '../domains/memory/CollectionReadModel.js';
import type { CollectionKind, CollectionManifest, CollectionSensitivity } from '../domains/memory/collection-types.js';
import { COLLECTION_SENSITIVITY_ORDER, validateManifestInput } from '../domains/memory/collection-types.js';
import {
  resolveCollectionStorePath,
  saveExternalCollection,
  updateExternalCollection,
} from '../domains/memory/external-collections.js';
import { GraphQueryResolver } from '../domains/memory/GraphQueryResolver.js';
import { GraphResolver } from '../domains/memory/GraphResolver.js';
import type { IEmbeddingService, IEvidenceStore } from '../domains/memory/interfaces.js';
import type { LibraryCatalog } from '../domains/memory/LibraryCatalog.js';
import { RecentBrowseResolver } from '../domains/memory/RecentBrowseResolver.js';
import { getRecallStats24h } from '../domains/memory/recall-stats.js';
import { SqliteEvidenceStore } from '../domains/memory/SqliteEvidenceStore.js';
import { resolveCollectionScanner } from '../domains/memory/scanner-resolver.js';
import { ensureVectorTable } from '../domains/memory/schema.js';
import { computeFromThreads } from '../domains/memory/ToolUsageMetricsAggregator.js';
import { VectorStore } from '../domains/memory/VectorStore.js';
import { buildThreadCrossPostSuggestion, extractThreadIdFromRecentAnchor } from './cross-thread-affordance.js';

export interface LibraryRoutesOptions {
  catalog: LibraryCatalog;
  stores: Map<string, IEvidenceStore>;
  dataDir?: string;
  managedVaultBase?: string;
  embeddingService?: IEmbeddingService;
  embedMode?: 'shadow' | 'on';
  getEmbeddingService?: () => IEmbeddingService | undefined;
  getEmbedMode?: () => 'shadow' | 'on' | undefined;
  // F188 Phase F AC-F9: optional Redis client for tool-usage-metrics endpoint.
  // Typed as `unknown` to accept any RedisClient implementation (ioredis, etc.);
  // ToolEventLog will narrow internally via its own constructor signature.
  redis?: unknown;
  // AC-H1 P1 R3: parent IndexBuilder for runtime exclude updates
  indexBuilder?: import('../domains/memory/IndexBuilder.js').IndexBuilder;
  parentRoot?: string;
}

type StoreWithDb = IEvidenceStore & { getDb?: () => import('better-sqlite3').Database };
type StoreWithGetRelated = IEvidenceStore & import('../domains/memory/GraphResolver.js').GraphStore;

interface BindDryRunRequestBody {
  root?: unknown;
  exclude?: unknown;
  authorityCeiling?: unknown;
}

type ValidBindDryRunBody =
  | {
      ok: true;
      root: string;
      exclude?: string[];
      authorityCeiling?: string;
    }
  | { ok: false; error: string };

function validateBindDryRunBody(body: BindDryRunRequestBody | undefined): ValidBindDryRunBody {
  if (!body || typeof body !== 'object' || typeof body.root !== 'string' || !body.root) {
    return { ok: false, error: 'root is required and must be a non-empty string' };
  }
  if (body.exclude !== undefined) {
    if (!Array.isArray(body.exclude) || !body.exclude.every((e: unknown) => typeof e === 'string')) {
      return { ok: false, error: 'exclude must be a string array' };
    }
  }
  return {
    ok: true,
    root: body.root,
    exclude: body.exclude as string[] | undefined,
    authorityCeiling: typeof body.authorityCeiling === 'string' ? body.authorityCeiling : undefined,
  };
}

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
      root?: string;
      sensitivity?: string;
      scannerLevel?: number | 'auto';
      exclude?: string[];
    };

    let resolvedRoot = body.root;
    if (!resolvedRoot && opts.managedVaultBase) {
      const safeId = body.id?.replace(/:/g, '-') ?? 'unknown';
      if (/[/\\]|\.\./.test(safeId)) {
        reply.status(400);
        return { error: 'Invalid collection id: path traversal characters not allowed' };
      }
      const vaultDir = join(opts.managedVaultBase, 'library', 'sources', safeId);
      mkdirSync(vaultDir, { recursive: true });
      resolvedRoot = vaultDir;
    }

    if (!resolvedRoot) {
      reply.status(400);
      return { error: 'root is required (or configure managedVaultBase for managed vault mode)' };
    }

    try {
      validateManifestInput({ ...body, root: resolvedRoot });
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
      root: resolvedRoot,
      sensitivity: (body.sensitivity ?? 'private') as CollectionSensitivity,
      scannerLevel: (body.scannerLevel ?? 'auto') as CollectionManifest['scannerLevel'],
      status: 'registered',
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

    // AC-H1 P1 R3+R4: update parent excludes + purge leaked rows if child overlaps parent root
    if (opts.indexBuilder && opts.parentRoot && resolvedRoot) {
      const absParent = resolve(opts.parentRoot);
      const absChild = resolve(resolvedRoot);
      if (absChild.startsWith(absParent + '/') && absChild !== absParent) {
        const rel = relative(absParent, absChild);
        const pattern = `${rel}/**`;
        opts.indexBuilder.addExcludePatterns([pattern]);

        // R4: immediately purge existing parent rows matching child prefix
        const parentStore = opts.stores.get('project:cat-cafe');
        if (parentStore && 'removeBySourcePrefix' in parentStore) {
          (parentStore as SqliteEvidenceStore).removeBySourcePrefix(`${rel}/`);
        }

        // R4: update parent catalog manifest so library rebuild path also respects new excludes
        const parentManifest = opts.catalog.get('project:cat-cafe');
        if (parentManifest) {
          const existing = parentManifest.exclude ?? [];
          if (!existing.includes(pattern)) {
            parentManifest.exclude = [...existing, pattern];
            parentManifest.updatedAt = new Date().toISOString();
          }
        }
      }
    }

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
    const body = request.body as { force?: boolean } | undefined;

    let embedDeps: CollectionEmbedDeps | undefined;
    const db = (store as StoreWithDb).getDb?.();
    const resolveEmbeddingService = () =>
      opts.getEmbeddingService ? opts.getEmbeddingService() : opts.embeddingService;
    const resolveEmbedMode = () => (opts.getEmbedMode ? opts.getEmbedMode() : (opts.embedMode ?? 'shadow'));
    const embeddingService = resolveEmbeddingService();
    if (embeddingService && db) {
      try {
        const sqliteVecMod = await import('sqlite-vec');
        sqliteVecMod.load(db);
        const dim = embeddingService.getModelInfo().dim;
        if (ensureVectorTable(db, dim)) {
          const vectorStore = new VectorStore(db, dim);
          embedDeps = {
            getEmbeddingService: () => {
              const current = resolveEmbeddingService();
              return current === embeddingService && resolveEmbedMode() ? current : undefined;
            },
            vectorStore,
          };
          const mode = resolveEmbedMode() ?? 'shadow';
          (store as SqliteEvidenceStore).setEmbedDeps({ embedding: embeddingService, vectorStore, mode });
        }
      } catch {
        // fail-open: sqlite-vec not available → FTS-only
      }
    }

    try {
      opts.catalog.setStatus(manifest.id, 'indexing');
    } catch {
      // already indexing or invalid transition — proceed anyway
    }

    const builder = new CollectionIndexBuilder(store as SqliteEvidenceStore, manifest, scanner, embedDeps);
    const result = await builder.rebuild({ force: body?.force ?? false });

    const finalStatus = result.blocked ? 'blocked' : 'active';
    try {
      opts.catalog.setStatus(manifest.id, finalStatus);
    } catch {
      // transition guard may reject if state was mutated concurrently
    }
    try {
      if (opts.dataDir) updateExternalCollection(opts.dataDir, manifest.id, { status: finalStatus });
    } catch {
      /* persist best-effort */
    }
    return result;
  });

  app.post('/api/library/bind-dry-run', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const body = validateBindDryRunBody(request.body as BindDryRunRequestBody | undefined);
    if (!body.ok) {
      reply.status(400);
      return { error: body.error };
    }
    let stat: ReturnType<typeof statSync>;
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
    return BindingDryRun.run(body.root, { exclude: body.exclude, authorityCeiling: body.authorityCeiling });
  });

  app.post<{ Params: { collectionId: string } }>('/api/library/:collectionId/archive', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const { collectionId } = request.params;
    const existing = opts.catalog.get(collectionId);
    if (!existing) {
      reply.status(404);
      return { error: `Collection "${collectionId}" not found` };
    }
    const BUILT_IN_IDS = new Set(['project:cat-cafe', 'global:methods']);
    if (BUILT_IN_IDS.has(collectionId)) {
      reply.status(400);
      return { error: `Cannot archive built-in collection "${collectionId}"` };
    }
    try {
      const manifest = opts.catalog.archive(collectionId);
      const store = opts.stores.get(collectionId);
      if (store && 'close' in store && typeof store.close === 'function') {
        (store as { close: () => void }).close();
      }
      opts.stores.delete(collectionId);
      if (opts.dataDir) {
        const safeId = collectionId.replace(/:/g, '-');
        const activeDir = join(opts.dataDir, 'library', safeId);
        const archiveDir = join(opts.dataDir, 'library', 'archives', safeId);
        try {
          mkdirSync(join(opts.dataDir, 'library', 'archives'), { recursive: true });
          renameSync(activeDir, archiveDir);
        } catch {
          /* move best-effort — index stays accessible but store is removed from map */
        }
      }
      try {
        if (opts.dataDir) updateExternalCollection(opts.dataDir, collectionId, { status: 'archived' });
      } catch {
        /* persist best-effort */
      }
      return { manifest };
    } catch (e: unknown) {
      reply.status(400);
      return { error: (e as Error).message };
    }
  });

  app.post<{ Params: { collectionId: string } }>('/api/library/:collectionId/unarchive', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const { collectionId } = request.params;
    const existing = opts.catalog.get(collectionId);
    if (!existing) {
      reply.status(404);
      return { error: `Collection "${collectionId}" not found` };
    }
    try {
      opts.catalog.unarchive(collectionId);
      if (opts.dataDir) {
        const safeId = collectionId.replace(/:/g, '-');
        const archiveDir = join(opts.dataDir, 'library', 'archives', safeId);
        const activeDir = join(opts.dataDir, 'library', safeId);
        try {
          renameSync(archiveDir, activeDir);
        } catch {
          /* restore best-effort — will be recreated on rebuild */
        }
        const storePath = resolveCollectionStorePath(opts.dataDir, collectionId);
        mkdirSync(dirname(storePath), { recursive: true });
        const newStore = new SqliteEvidenceStore(storePath);
        await newStore.initialize();
        opts.stores.set(collectionId, newStore);
      }
      try {
        if (opts.dataDir) updateExternalCollection(opts.dataDir, collectionId, { status: 'registered' });
      } catch {
        /* persist best-effort */
      }
      return { manifest: opts.catalog.get(collectionId) };
    } catch (e: unknown) {
      reply.status(400);
      return { error: (e as Error).message };
    }
  });

  app.put<{ Params: { collectionId: string } }>('/api/library/:collectionId/sensitivity', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const { collectionId } = request.params;
    const body = request.body as { sensitivity?: string; confirm?: boolean } | undefined;
    const sensitivity = body?.sensitivity;
    if (!sensitivity || !Object.hasOwn(COLLECTION_SENSITIVITY_ORDER, sensitivity)) {
      reply.status(400);
      return { error: `Invalid sensitivity: must be one of public, internal, private, restricted` };
    }
    const existing = opts.catalog.get(collectionId);
    if (!existing) {
      reply.status(404);
      return { error: `Collection "${collectionId}" not found` };
    }

    const fromOrder = COLLECTION_SENSITIVITY_ORDER[existing.sensitivity];
    const toOrder = COLLECTION_SENSITIVITY_ORDER[sensitivity as CollectionSensitivity];
    const isWidening = toOrder > fromOrder;
    const isNarrowing = toOrder < fromOrder;

    if (isWidening && !body?.confirm) {
      reply.status(409);
      return {
        direction: 'widening',
        from: existing.sensitivity,
        to: sensitivity,
        requiresConfirmation: true,
        message: `Widening from ${existing.sensitivity} to ${sensitivity} makes data visible to more contexts. Send confirm: true to proceed.`,
      };
    }

    const change = opts.catalog.updateSensitivity(collectionId, sensitivity as CollectionSensitivity);
    try {
      if (opts.dataDir)
        updateExternalCollection(opts.dataDir, collectionId, { sensitivity: sensitivity as CollectionSensitivity });
    } catch {
      /* persist best-effort */
    }

    let reindexTriggered = false;
    if (isNarrowing) {
      const store = opts.stores.get(collectionId);
      if (store) {
        try {
          const manifest = opts.catalog.get(collectionId)!;
          const scanner = resolveCollectionScanner(manifest);
          const builder = new CollectionIndexBuilder(store as SqliteEvidenceStore, manifest, scanner);
          await builder.rebuild({ force: true });
          reindexTriggered = true;
        } catch {
          // best-effort reindex
        }
      }
    }

    return { ...change, ...(reindexTriggered ? { reindexTriggered } : {}) };
  });

  app.get('/api/library/graph', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const qs = request.query as { anchor?: string; depth?: string; collection?: string };
    if (!qs.anchor) {
      reply.status(400);
      return { error: 'anchor query parameter is required' };
    }
    const depth = qs.depth ? Number.parseInt(qs.depth, 10) : 1;
    if (Number.isNaN(depth) || depth < 0 || depth > 3) {
      reply.status(400);
      return { error: 'depth must be 0-3' };
    }
    // 砚砚 五审 P1-A: client query `collections` removed — was being used as ACL
    // (callerCollections), which let any localhost client self-grant private
    // collection visibility. v1 default: no callerCollections (resolver defaults
    // to public/internal only). Server-side identity derivation is future work.
    const callerCollections: string[] | undefined = undefined;
    const graphStores = new Map<string, StoreWithGetRelated>();
    for (const [id, s] of opts.stores) {
      if ('getRelated' in s) graphStores.set(id, s as StoreWithGetRelated);
    }
    const resolver = new GraphResolver(opts.catalog, graphStores);
    return resolver.buildSubgraph(qs.anchor, { depth, callerCollections, centerCollectionId: qs.collection });
  });

  app.get('/api/library/graph/resolve', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const qs = request.query as { query?: string; depth?: string; relations?: string };
    if (!qs.query?.trim()) {
      reply.status(400);
      return { error: 'query parameter is required' };
    }
    const depth = qs.depth ? Number.parseInt(qs.depth, 10) : 1;
    if (Number.isNaN(depth) || depth < 0 || depth > 3) {
      reply.status(400);
      return { error: 'depth must be 0-3' };
    }
    // 砚砚 cloud-9 P1: parse + validate relations filter, then pass to resolver
    // so the traversal itself skips disallowed edges (not just render).
    const VALID_RELATIONS = ['wikilink', 'doc_link', 'feature_ref', 'related_to'] as const;
    type RelationT = (typeof VALID_RELATIONS)[number];
    let relations: readonly string[] | undefined;
    if (qs.relations !== undefined && qs.relations !== '') {
      const parts = qs.relations.split(',').filter(Boolean);
      const invalid = parts.find((p) => !VALID_RELATIONS.includes(p as RelationT));
      if (invalid) {
        reply.status(400);
        return { error: `relations must be subset of: ${VALID_RELATIONS.join(', ')} (got: ${invalid})` };
      }
      relations = parts;
    }
    // 砚砚 五审 P1-A: callerCollections removed from query — see /api/library/graph
    const callerCollections: string[] | undefined = undefined;
    const resolver = new GraphQueryResolver(opts.catalog, opts.stores);
    return resolver.resolve(qs.query, { depth, callerCollections, ...(relations ? { relations } : {}) });
  });

  // F188 Phase F AC-F9: tool usage metrics Dashboard panel data
  app.get('/api/library/tool-usage-metrics', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    if (!opts.redis) {
      reply.status(503);
      return { error: 'Tool usage metrics require Redis (F188 Phase F event log)', insufficient_data: true };
    }
    // 砚砚 六审 P1-A: use ToolEventLog.listThreadIds() which handles keyPrefix
    // and filters :seq counter siblings (was hitting WRONGTYPE).
    const eventLog = new ToolEventLog(opts.redis as ConstructorParameters<typeof ToolEventLog>[0]);
    const threadIds = await eventLog.listThreadIds();
    const threads = threadIds.map((threadId) => ({ threadId }));
    const metrics = await computeFromThreads(eventLog, threads);

    // F200 AC-A4: attach recall event stats from evidence.sqlite
    let recallEventStats: ReturnType<typeof getRecallStats24h> | undefined;
    for (const store of opts.stores.values()) {
      const db = (store as StoreWithDb).getDb?.();
      if (db) {
        try {
          recallEventStats = getRecallStats24h(db);
        } catch {}
        break;
      }
    }

    return { ...metrics, recallEventStats };
  });

  // F188 Phase F AC-F2: time-based browse for cold-start / scan-recent use case
  app.get('/api/library/recent', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    const qs = request.query as {
      scope?: string;
      since?: string;
      limit?: string;
      kinds?: string;
      verified?: string;
      currentThreadId?: string;
    };
    const since = qs.since?.trim() || '7d';
    // 砚砚 cloud-7 P2: validate `since` format. parseSinceToIso falls back to
    // returning the input unchanged for unrecognized values, which then enters
    // SQL `WHERE updated_at >= ?` as a string comparison — typos like
    // `since=tomorrow` / `since=7days` silently produce empty/wrong slices.
    // Accept relative durations (\d+d / \d+h) or ISO 8601 date.
    if (!isValidSince(since)) {
      reply.status(400);
      return { error: 'since must be /\\d+d/, /\\d+h/, or ISO 8601 date (e.g. 7d, 24h, 2026-05-01)' };
    }
    const limit = qs.limit ? Number.parseInt(qs.limit, 10) : 20;
    if (Number.isNaN(limit) || limit < 1 || limit > 100) {
      reply.status(400);
      return { error: 'limit must be 1-100' };
    }
    const validScopes = ['docs', 'threads', 'memory', 'all', 'trajectories'] as const;
    type ScopeT = (typeof validScopes)[number];
    // 砚砚 cloud-5 P2: reject invalid scope rather than silently coercing to undefined.
    // Pre-fix, `scope=thread` (typo) would silently widen to no-scope and skew metrics
    // because callers thought they requested a narrow surface.
    let scope: ScopeT | undefined;
    if (qs.scope !== undefined && qs.scope !== '') {
      if (!validScopes.includes(qs.scope as ScopeT)) {
        reply.status(400);
        return { error: `scope must be one of: ${validScopes.join(', ')}` };
      }
      scope = qs.scope as ScopeT;
    }
    // DF-4 P1-1 fix: removed trajectory special-case that bypassed resolver.
    // scope='trajectories' now flows through RecentBrowseResolver.list() which
    // returns filesRead/filesModified/verified metadata from task_trajectories.
    const kinds = qs.kinds?.split(',').filter(Boolean);
    const verified = qs.verified === 'true' ? true : qs.verified === 'false' ? false : undefined;
    // 砚砚 五审 P1-A: callerCollections removed from query
    const callerCollections: string[] | undefined = undefined;
    const resolver = new RecentBrowseResolver(opts.catalog, opts.stores);
    const result = await resolver.list({ scope, since, limit, kinds, callerCollections, verified });
    const currentThreadId = qs.currentThreadId?.trim();
    const items = result.items.map((item) => {
      const suggestedAction = buildThreadCrossPostSuggestion(
        item.kind === 'thread' ? extractThreadIdFromRecentAnchor(item.anchor) : undefined,
        currentThreadId,
        'list_recent',
        'Recent item is another thread; dispatch relevant findings back to that thread.',
      );
      return suggestedAction ? { ...item, suggestedAction } : item;
    });
    const response: Record<string, unknown> = { items };
    if (result.groups) response.groups = result.groups;
    if (result.nudge) response.nudge = result.nudge;
    return response;
  });
};

/**
 * Accept relative durations `\d+d` / `\d+h` or ISO 8601 date (YYYY-MM-DD or
 * full ISO 8601 timestamp). Rejects bare strings like `tomorrow` / `7days`
 * which would fall through to SQL string-comparison and silently produce
 * empty/full result slices.
 *
 * 砚砚 cloud-10 P2: full-string anchored ISO regex. `Date.parse` is
 * permissive (accepts trailing garbage in some runtimes); the prefix check
 * was too loose. Full anchor + Date.parse both required.
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
// 砚砚 cloud-11 P2: cap digits on relative durations. Max 5 = 99999d (~273
// years) / 99999h (~11 years). Without this cap, `since=999999999999999d`
// passes route validation, overflows Date arithmetic, and crashes
// toISOString → 500. Reasonable "recent" windows fit well under 5 digits.
const RELATIVE_SINCE_RE = /^\d{1,5}[dh]$/;

function isValidSince(since: string): boolean {
  if (RELATIVE_SINCE_RE.test(since)) return true;
  if (!ISO_8601_RE.test(since)) return false;
  const ms = Date.parse(since);
  return !Number.isNaN(ms);
}
