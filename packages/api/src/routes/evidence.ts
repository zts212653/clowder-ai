import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  type CatalogCollectionSnapshot,
  type ConfigWarning,
  computeFunctionalStatus,
  evaluateConfigWarnings,
  type FunctionalStatus,
} from '../domains/memory/evidence-status-signals.js';
import { F163ExperimentLogger } from '../domains/memory/f163-experiment-logger.js';
import {
  applySalienceRerank,
  computeVariantId,
  freezeFlags,
  getOrAssignCohort,
  rankToConfidence,
  type SalienceTaskContext,
} from '../domains/memory/f163-types.js';
import type {
  EvidenceItem,
  IEmbeddingService,
  IEvidenceStore,
  IIndexBuilder,
  IKnowledgeResolver,
  SearchExecutionMeta,
  SearchOptions,
} from '../domains/memory/interfaces.js';
import type { LibraryCatalog } from '../domains/memory/LibraryCatalog.js';
import type { RebuildJobTracker } from '../domains/memory/RebuildJobTracker.js';
import { buildThreadCrossPostSuggestion, extractThreadIdFromEvidenceResult } from './cross-thread-affordance.js';
import {
  type BoostSource,
  type EvidenceResult,
  mapKindToSourceType,
  sanitizeEvidenceDrillDown,
} from './evidence-helpers.js';

/** Accepted query parameters — Phase D: scope/mode/depth added */
const searchSchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  scope: z.enum(['docs', 'memory', 'threads', 'sessions', 'all']).optional(),
  mode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
  depth: z.enum(['summary', 'raw']).optional(),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  contextWindow: z.coerce.number().int().min(1).max(5).optional(),
  threadId: z.string().optional(),
  dimension: z.enum(['project', 'global', 'library', 'collection', 'all']).optional(),
  collections: z.string().optional(),
  explain: z.enum(['true', '1']).optional(),
  activeFeatureIds: z.string().optional(),
  truthSourceRef: z.string().optional(),
  recentArtifactRefs: z.string().optional(),
  currentThreadId: z.string().optional(),
  /** F200 HW-1: search intent — topk (default) or coverage (exhaustive multi-scope) */
  intent: z.enum(['topk', 'coverage']).optional(),
  /** F256 Phase B: opt-out of expansion hints in topk results (default: true) */
  include_expansion: z.enum(['true', 'false', '1', '0']).optional(),
});

export type {
  EvidenceConfidence,
  EvidenceFreshness,
  EvidenceReimportTrigger,
  EvidenceSourceType,
} from './evidence-helpers.js';

import type { EvidenceFreshness, EvidenceReimportTrigger } from './evidence-helpers.js';

export interface EvidenceSearchResponse {
  results: EvidenceResult[];
  degraded: boolean;
  degradeReason?: string;
  /** Actual retrieval mode after resolver/store degradation handling. */
  effectiveMode?: 'lexical' | 'semantic' | 'hybrid';
  freshness?: EvidenceFreshness;
  reimportTrigger?: EvidenceReimportTrigger;
  /** F163: deterministic variant ID from frozen flag snapshot */
  variantId: string;
  /** F163: anchors of always_on docs injected into system prompt (not search results) */
  injectionSources?: string[];
  collectionGroups?: Array<{
    collectionId: string;
    sensitivity: string;
    status: string;
    itemCount: number;
    durationMs: number;
  }>;
  deprecationWarnings?: string[];
  /** F256 Phase B: expansion hints — related directions surfaced from topk results */
  expansionHints?: Array<{
    anchor: string;
    title: string;
    kind: string;
    sourcePath?: string;
    provenance: { source: string; via: string; confidence: string };
  }>;
}

export interface EvidenceRoutesOptions {
  docsRoot?: string;
  evidenceStore: IEvidenceStore;
  embeddingService?: Pick<IEmbeddingService, 'isReady'>;
  getEmbeddingService?: () => Pick<IEmbeddingService, 'isReady'> | undefined;
  indexBuilder?: IIndexBuilder;
  knowledgeResolver?: IKnowledgeResolver;
  rebuildJobTracker?: RebuildJobTracker;
  /**
   * F188 Phase K (AC-K2): library catalog snapshot for `docs_root_suspicious`
   * detection. Optional — when absent, the docs-root detector is skipped
   * (worktree / no-catalog scenarios remain functional).
   */
  catalog?: Pick<LibraryCatalog, 'list' | 'getRoutable'>;
}

export const evidenceRoutes: FastifyPluginAsync<EvidenceRoutesOptions> = async (app, opts) => {
  app.get('/api/evidence/search', async (request, reply) => {
    const parseResult = searchSchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parseResult.error.issues };
    }

    const {
      q,
      limit,
      scope,
      mode,
      depth,
      dateFrom,
      dateTo,
      contextWindow,
      threadId,
      dimension,
      collections: rawCollections,
      explain: rawExplain,
      activeFeatureIds: rawFeatureIds,
      truthSourceRef,
      recentArtifactRefs: rawArtifactRefs,
      currentThreadId,
      intent,
      include_expansion: rawIncludeExpansion,
    } = parseResult.data;

    // F200 HW-1: intent=coverage → CoverageSearchService bypass (separate pipeline)
    // Wiring gaps (by design for HW-1 v1, documented in plan §Task 6):
    //   - conventionGraph: no production ConventionGraphAdapter yet (F242 soft dep).
    //     Service gracefully degrades with `degraded: [{source: 'convention-graph', ...}]`.
    //   - onCoverageEvent: telemetry callback not wired; persistence deferred to HW-1 Phase 2.
    //     catId/invocationId in CoverageSearchEvent are placeholder empty strings until then.
    if (intent === 'coverage') {
      try {
        const { CoverageSearchService } = await import('../domains/memory/CoverageSearchService.js');
        const coverageService = new CoverageSearchService(opts.evidenceStore);
        const coverageResult = await coverageService.search(q);
        return coverageResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        reply.status(500);
        return { error: 'Coverage search failed', details: message };
      }
    }

    const effectiveLimit = limit ?? 5;
    // F163: freeze flags once per request, compute variant ID
    const f163Flags = freezeFlags();
    const rawVariantId = computeVariantId(f163Flags);
    const anyF163Active = Object.values(f163Flags).some((v) => v !== 'off');
    // P1-4: cohort sticky routing — same thread keeps same variant across flag changes
    const db = (opts.evidenceStore as { getDb?: () => import('better-sqlite3').Database }).getDb?.();
    const variantId = db && threadId ? getOrAssignCohort(db, threadId, rawVariantId) : rawVariantId;
    const boostSource: BoostSource[] = anyF163Active
      ? f163Flags.authorityBoost !== 'off'
        ? ['authority_boost']
        : ['legacy']
      : ['legacy'];
    try {
      const parsedCollections = rawCollections
        ?.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const explain = rawExplain != null;
      const searchOpts: SearchOptions = {
        limit: effectiveLimit,
        scope,
        mode,
        depth,
        dateFrom,
        dateTo,
        contextWindow,
        threadId,
        dimension,
        collections: parsedCollections,
        explain,
      };
      let searchMeta: SearchExecutionMeta = { degraded: false };
      // F-4: Use KnowledgeResolver for federated project + global search
      const resolveResult = opts.knowledgeResolver ? await opts.knowledgeResolver.resolve(q, searchOpts) : null;
      let items: EvidenceItem[];
      if (resolveResult) {
        items = resolveResult.results;
        searchMeta = resolveResult.meta ?? missingResolverMeta(searchOpts);
      } else {
        if (opts.evidenceStore.searchWithMeta) {
          const execution = await opts.evidenceStore.searchWithMeta(q, searchOpts);
          items = execution.items;
          searchMeta = execution.meta;
        } else {
          items = await opts.evidenceStore.search(q, searchOpts);
          searchMeta = missingResolverMeta(searchOpts);
        }
      }
      const resolvedSources = resolveResult?.sources;
      // Tag per-result source when dimension is explicit (single-source)
      const singleSource = resolvedSources && resolvedSources.length === 1 ? resolvedSources[0] : undefined;

      // F256 Phase B: expansion hints for topk results (opt-out via include_expansion=false)
      const wantExpansion = rawIncludeExpansion !== 'false' && rawIncludeExpansion !== '0';
      let expansionHints: import('../domains/memory/TopkExpansionService.js').ExpansionHint[] | undefined;
      if (wantExpansion && items.length > 0 && opts.evidenceStore.searchWithMeta) {
        try {
          const { TopkExpansionService } = await import('../domains/memory/TopkExpansionService.js');
          const expansionService = new TopkExpansionService(opts.evidenceStore);
          expansionHints = await expansionService.expand(items, q);
        } catch {
          /* fail-open: expansion failure does not block search */
        }
      }

      // Phase F: assemble task context for salience gating (no-op when absent)
      const salienceCtx: SalienceTaskContext = {
        activeFeatureIds: rawFeatureIds
          ? rawFeatureIds
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
        truthSourceRef: truthSourceRef ?? null,
        recentArtifactRefs: rawArtifactRefs
          ? rawArtifactRefs
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      };

      // Phase F: compute salience rerank for both shadow and on (shadow = log only)
      const salienceResult = f163Flags.retrievalRerank !== 'off' ? applySalienceRerank(items, salienceCtx) : null;

      // P1-1 fix: only apply reranked order to user-visible results when fully enabled
      const reranked =
        salienceResult && f163Flags.retrievalRerank === 'on' ? salienceResult : { items, scores: items.map(() => 1.0) };

      const effectiveBoostSource: BoostSource[] =
        f163Flags.retrievalRerank === 'on' ? [...boostSource, 'retrieval_rerank'] : boostSource;

      const results: EvidenceResult[] = reranked.items.map((item, index) => {
        const drillDown = sanitizeEvidenceDrillDown(item.drillDown);
        const suggestedAction = buildThreadCrossPostSuggestion(
          extractThreadIdFromEvidenceResult({
            passages: item.passages,
            drillDown,
            anchor: item.kind === 'thread' ? item.anchor : undefined,
          }),
          currentThreadId,
          'search_evidence',
          'Search result came from another thread; dispatch relevant findings back to that thread.',
        );
        return {
          title: item.title,
          anchor: item.anchor,
          snippet: item.summary ?? '',
          confidence: rankToConfidence(index),
          sourceType: mapKindToSourceType(item.kind),
          boostSource: effectiveBoostSource,
          ...(item.authority ? { authority: item.authority } : {}),
          ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
          ...(singleSource ? { source: singleSource } : {}),
          ...(item.passages ? { passages: item.passages } : {}),
          ...(item.matchReason ? { matchReason: item.matchReason } : {}),
          ...(item.entityMatches ? { entityMatches: item.entityMatches } : {}),
          ...(drillDown ? { drillDown } : {}),
          ...(explain && item.rankingFactors ? { rankingFactors: item.rankingFactors } : {}),
          ...(suggestedAction ? { suggestedAction } : {}),
        };
      });
      // F163 AC-A3: report always_on injection sources in response envelope
      let injectionSources: string[] | undefined;
      if (f163Flags.alwaysOnInjection !== 'off') {
        const evStore = opts.evidenceStore as { queryAlwaysOn?: () => Array<{ anchor: string }> };
        if (typeof evStore.queryAlwaysOn === 'function') {
          injectionSources = evStore.queryAlwaysOn().map((d) => d.anchor);
        }
      }

      // P1-5: log search to f163_logs for experiment evidence chain
      if (anyF163Active && db) {
        try {
          const logger = new F163ExperimentLogger(db);
          logger.logSearch(variantId, f163Flags, {
            query: q,
            resultCount: results.length,
            limit: effectiveLimit,
            scope,
            dimension,
            collections: parsedCollections,
            topKPerCollection: Object.fromEntries(
              (resolveResult?.collectionGroups ?? []).map((g) => [
                g.collectionId,
                { count: g.items.length, anchors: g.items.map((i) => i.anchor) },
              ]),
            ),
          });
          // Phase F: salience rerank shadow diff (AC-F6) — logs in both shadow and on
          if (salienceResult) {
            logger.logSalienceRerank(variantId, f163Flags, {
              query: q,
              resultCount: results.length,
              salienceRerank: {
                taskContext: salienceCtx,
                before: items.map((i) => i.anchor),
                after: salienceResult.items.map((i) => i.anchor),
                scores: salienceResult.scores,
              },
            });
          }
        } catch {
          /* fail-open: logging failure does not block search */
        }
      }

      const responseGroups = resolveResult?.collectionGroups?.map((g) => ({
        collectionId: g.collectionId,
        sensitivity: g.sensitivity,
        status: g.status,
        itemCount: g.items.length,
        durationMs: g.durationMs,
      }));

      return {
        results,
        degraded: searchMeta.degraded,
        variantId,
        ...(searchMeta.degradeReason ? { degradeReason: searchMeta.degradeReason } : {}),
        ...(searchMeta.effectiveMode ? { effectiveMode: searchMeta.effectiveMode } : {}),
        ...(injectionSources && injectionSources.length > 0 ? { injectionSources } : {}),
        ...(responseGroups && responseGroups.length > 0 ? { collectionGroups: responseGroups } : {}),
        ...(resolveResult?.deprecationWarnings ? { deprecationWarnings: resolveResult.deprecationWarnings } : {}),
        ...(expansionHints && expansionHints.length > 0 ? { expansionHints } : {}),
      } satisfies Partial<EvidenceSearchResponse>;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStack = err instanceof Error ? err.stack : undefined;
      const errCause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
      request.log.error(
        {
          serviceArea: 'evidence-search',
          query: q,
          scope,
          mode,
          depth,
          dimension,
          threadId,
          errMsg,
          errStack,
          errCause,
        },
        'evidence search failed — returning degraded response',
      );
      return {
        results: [],
        degraded: true,
        degradeReason: 'evidence_store_error',
        variantId,
      } satisfies Partial<EvidenceSearchResponse>;
    }
  });

  // F102 D-2/D-8: Memory status (AC-D8)
  // F188 Phase K (AC-K1/K3): adds `functionalStatus` + `configWarnings[]` to
  // surface configuration health without touching the existing `healthy` field
  // semantic (KD-14 — external healthcheck backward compat).
  app.get('/api/evidence/status', async () => {
    // Helper: shape unhealthy responses with the Phase K schema extension so
    // the response type is stable across healthy / no_db / query_error paths
    // (砚砚 R3 P2-2). Frontend keeps red fatal banner priority when healthy=false.
    const fatalShape = (reason: 'no_db' | 'query_error') => ({
      backend: 'sqlite' as const,
      healthy: false as const,
      reason,
      functionalStatus: 'degraded' as FunctionalStatus,
      configWarnings: [] as ConfigWarning[],
    });

    try {
      const db = (opts.evidenceStore as { getDb?: () => unknown }).getDb?.() as
        | { prepare: (sql: string) => { get: () => Record<string, unknown> } }
        | undefined;
      if (!db) return fatalShape('no_db');

      const docCount = (db.prepare('SELECT count(*) AS c FROM evidence_docs').get() as { c: number }).c;
      const threadCount = (
        db.prepare("SELECT count(*) AS c FROM evidence_docs WHERE kind = 'thread'").get() as { c: number }
      ).c;
      const edgeCount = (db.prepare('SELECT count(*) AS c FROM edges').get() as { c: number }).c;
      // Prefer the explicit rebuild stamp written by IndexBuilder; fall back to
      // MAX(evidence_docs.updated_at) for old databases that predate the stamp.
      let lastUpdated: string | null = null;
      try {
        const stampRow = db.prepare("SELECT value FROM embedding_meta WHERE key = 'last_rebuild_at'").get() as
          | { value: string }
          | undefined;
        lastUpdated = stampRow?.value ?? null;
      } catch {
        /* embedding_meta may not exist in very old schemas */
      }
      if (!lastUpdated) {
        lastUpdated = (db.prepare('SELECT max(updated_at) AS t FROM evidence_docs').get() as { t: string | null }).t;
      }

      // Passages count (may not exist in older schemas)
      let passageCount = 0;
      try {
        passageCount = (db.prepare('SELECT count(*) AS c FROM evidence_passages').get() as { c: number }).c;
      } catch {
        /* table may not exist */
      }

      // F209: embedded passage-vector count + capability flag — lets the UI surface background
      // embedding warm-up (passage_vectors < passages means semantic recall is still warming up;
      // passage_fts is complete). `supported` distinguishes "warming up" from "vectors not available
      // at all" (embed off / sqlite-vec missing), so the UI never shows a warm-up that never finishes.
      let passageVectorCount = 0;
      let passageVectorsSupported = false;
      const passageEmbeddingReady = (opts.getEmbeddingService?.() ?? opts.embeddingService)?.isReady() === true;
      try {
        passageVectorCount = (db.prepare('SELECT count(*) AS c FROM passage_vectors').get() as { c: number }).c;
        passageVectorsSupported = passageEmbeddingReady;
      } catch {
        /* vec0 table may not exist (sqlite-vec unavailable / embedding off) → unsupported, not warming */
      }

      // Embedding model from embedding_meta (VectorStore.initMeta writes embedding_model_id)
      let embeddingModel: string | null = null;
      try {
        const row = db.prepare("SELECT value FROM embedding_meta WHERE key = 'embedding_model_id'").get() as
          | { value: string }
          | undefined;
        embeddingModel = row?.value ?? null;
      } catch {
        /* table may not exist */
      }

      // Vector index size. If the table query throws, sqlite-vec wasn't
      // loaded — already blocked at the install dialog via the matrix
      // 'unsupported' branch, so we just defensively return 0 here.
      let vectorsCount = 0;
      try {
        vectorsCount = (db.prepare('SELECT count(*) AS c FROM evidence_vectors').get() as { c: number }).c;
      } catch {
        /* vec0 virtual table missing — install dialog blocked this case */
      }

      // F188 Phase K (AC-K2): build signals → evaluate config warnings →
      // derive functionalStatus. Pure compute, no extra DB / fs cost beyond
      // the docs-root inspection inside detectDocsRootSuspicious.
      const catalogCollections: CatalogCollectionSnapshot[] = opts.catalog
        ? opts.catalog.list().map((m) => ({
            id: m.id,
            root: m.root,
            kind: m.kind,
            status: m.status,
          }))
        : [];
      const configWarnings = evaluateConfigWarnings({
        dbCounts: {
          docs_count: docCount,
          edges_count: edgeCount,
          vectors_count: vectorsCount,
          passage_vectors_count: passageVectorCount,
          threads_count: threadCount,
          passages_count: passageCount,
        },
        embeddingMeta: { embedding_model: embeddingModel },
        embeddingService: { passage_vectors_supported: passageVectorsSupported },
        catalogSnapshot: { collections: catalogCollections },
      });
      const functionalStatus = computeFunctionalStatus(configWarnings);

      return {
        backend: 'sqlite',
        healthy: true,
        docs_count: docCount,
        threads_count: threadCount,
        passages_count: passageCount,
        passage_vectors_count: passageVectorCount,
        passage_vectors_supported: passageVectorsSupported,
        passage_warmup_active: opts.indexBuilder?.isPassageWarmupActive() ?? false,
        edges_count: edgeCount,
        vectors_count: vectorsCount,
        last_rebuild_at: lastUpdated,
        embedding_model: embeddingModel,
        // F188 Phase K (AC-K1/K3): config health surface.
        functionalStatus,
        configWarnings,
      };
    } catch {
      return fatalShape('query_error');
    }
  });

  // F102 D-11/D-12: Incremental reindex endpoint (AC-D11, AC-D12)
  // Internal-only: called by feat-lifecycle or local processes that modify docs
  const reindexSchema = z.object({
    paths: z.array(z.string().min(1)).min(1).max(50),
  });

  app.post('/api/evidence/reindex', async (request, reply) => {
    // P1 fix: localhost-only guard — this mutates index state
    const remoteIp = request.ip;
    if (remoteIp !== '127.0.0.1' && remoteIp !== '::1' && remoteIp !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'reindex only allowed from localhost' };
    }

    if (!opts.indexBuilder) {
      reply.status(503);
      return { error: 'indexBuilder not available' };
    }
    const parsed = reindexSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    try {
      // P1 fix: collect anchors BEFORE incrementalUpdate (deletion would remove them)
      const preAnchors: string[] = [];
      const db = (opts.evidenceStore as { getDb?: () => unknown }).getDb?.() as
        | { prepare: (sql: string) => { all: (...args: unknown[]) => Array<Record<string, unknown>> } }
        | undefined;
      if (db) {
        for (const filePath of parsed.data.paths) {
          const rows = db
            .prepare('SELECT anchor FROM evidence_docs WHERE source_path = ?')
            .all(filePath.replace(/^docs\//, '')) as Array<{ anchor: string }>;
          for (const { anchor } of rows) {
            preAnchors.push(anchor);
          }
        }
      }

      await opts.indexBuilder.incrementalUpdate(parsed.data.paths);

      // D-19: Memory invalidation — find dependents of pre-change anchors via edges
      const invalidated: string[] = [];
      if (db && preAnchors.length > 0) {
        for (const anchor of preAnchors) {
          const deps = db
            .prepare('SELECT from_anchor FROM edges WHERE to_anchor = ? AND relation IN (?, ?)')
            .all(anchor, 'related', 'evolved_from') as Array<{ from_anchor: string }>;
          for (const dep of deps) {
            if (!invalidated.includes(dep.from_anchor)) {
              invalidated.push(dep.from_anchor);
            }
          }
        }
      }

      return {
        ok: true,
        paths: parsed.data.paths,
        invalidated: invalidated.length > 0 ? invalidated : undefined,
      };
    } catch (err) {
      reply.status(500);
      return { error: 'reindex failed', message: String(err) };
    }
  });

  // Passage embedding warmup trigger — re-starts background embedding for passages
  // that don't have vectors yet. Safe to call repeatedly (skips already-embedded).
  app.post('/api/evidence/warmup', async (request, reply) => {
    // Use the same direct-IP guard as /reindex and /rebuild — isDirectLoopbackRequest
    // was overly strict here (rejects when any proxy-forwarding header is present,
    // even though the request genuinely originates from localhost).
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    if (!opts.indexBuilder) {
      reply.status(503);
      return { error: 'warmup not available' };
    }
    opts.indexBuilder.startPassageEmbeddingWarmup();
    return { ok: true };
  });

  // F188 Phase A: Full rebuild endpoint (AC-A1)
  app.post('/api/evidence/rebuild', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    if (!opts.indexBuilder || !opts.rebuildJobTracker) {
      reply.status(503);
      return { error: 'rebuild not available' };
    }

    let taskId: string;
    try {
      taskId = opts.rebuildJobTracker.create();
    } catch (e) {
      reply.status(409);
      return { error: (e as Error).message };
    }

    const tracker = opts.rebuildJobTracker;
    const builder = opts.indexBuilder;
    setImmediate(() => {
      builder
        .rebuild({
          force: true,
          onProgress: (phase, percent) => tracker.updateProgress(taskId, phase, percent),
        })
        .then(
          (result) => tracker.complete(taskId, result),
          (err) => tracker.fail(taskId, String(err)),
        );
    });

    return { taskId };
  });

  // F188 Phase A: Rebuild status endpoint (AC-A2)
  app.get<{ Params: { taskId: string } }>('/api/evidence/rebuild/:taskId', async (request, reply) => {
    const ip = request.ip;
    if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
      reply.status(403);
      return { error: 'Forbidden: localhost only' };
    }
    if (!opts.rebuildJobTracker) {
      reply.status(503);
      return { error: 'rebuild not available' };
    }
    const job = opts.rebuildJobTracker.get(request.params.taskId);
    if (!job) {
      reply.status(404);
      return { error: 'Task not found' };
    }
    return job;
  });
};

function missingResolverMeta(options: SearchOptions): SearchExecutionMeta {
  if (options.depth === 'raw' && (options.mode ?? 'lexical') !== 'lexical') {
    return { degraded: true, degradeReason: 'raw_lexical_only', effectiveMode: 'lexical' };
  }
  return { degraded: false };
}
