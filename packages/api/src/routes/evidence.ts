/**
 * Evidence Search Route
 * GET /api/evidence/search — search project knowledge via SQLite evidence store.
 *
 * Phase 5.0: Evidence-first search.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { IEvidenceStore, IIndexBuilder, IKnowledgeResolver } from '../domains/memory/interfaces.js';
import { type EvidenceResult, mapKindToSourceType } from './evidence-helpers.js';

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
  dimension: z.enum(['project', 'global', 'all']).optional(),
});

export type { EvidenceConfidence, EvidenceSourceType } from './evidence-helpers.js';

export interface EvidenceFreshness {
  status: 'fresh' | 'stale' | 'unknown';
  checkedAt: string;
  headCommit?: string;
  watermarkCommit?: string;
  reason?: 'commit_match' | 'commit_mismatch' | 'watermark_missing' | 'head_unavailable';
}

export interface EvidenceReimportTrigger {
  status: 'triggered' | 'cooldown' | 'skipped' | 'disabled' | 'failed';
  reason?: string;
  nextAllowedAt?: string;
}

export interface EvidenceSearchResponse {
  results: EvidenceResult[];
  degraded: boolean;
  degradeReason?: string;
  freshness?: EvidenceFreshness;
  reimportTrigger?: EvidenceReimportTrigger;
}

export interface EvidenceRoutesOptions {
  docsRoot?: string;
  /** F102: SQLite evidence store — the only backend */
  evidenceStore: IEvidenceStore;
  /** F102 D-11: IndexBuilder for incremental reindex */
  indexBuilder?: IIndexBuilder;
  /** F-4: KnowledgeResolver for federated project + global search */
  knowledgeResolver?: IKnowledgeResolver;
}

export const evidenceRoutes: FastifyPluginAsync<EvidenceRoutesOptions> = async (app, opts) => {
  app.get('/api/evidence/search', async (request, reply) => {
    const parseResult = searchSchema.safeParse(request.query);
    if (!parseResult.success) {
      reply.status(400);
      return { error: 'Invalid query parameters', details: parseResult.error.issues };
    }

    const { q, limit, scope, mode, depth, dateFrom, dateTo, contextWindow, threadId, dimension } = parseResult.data;

    const effectiveLimit = limit ?? 5;
    try {
      const searchOpts = {
        limit: effectiveLimit,
        scope,
        mode,
        depth,
        dateFrom,
        dateTo,
        contextWindow,
        threadId,
        dimension,
      };
      // F-4: Use KnowledgeResolver for federated project + global search
      const resolveResult = opts.knowledgeResolver ? await opts.knowledgeResolver.resolve(q, searchOpts) : null;
      const items = resolveResult ? resolveResult.results : await opts.evidenceStore.search(q, searchOpts);
      const resolvedSources = resolveResult?.sources;
      // Tag per-result source when dimension is explicit (single-source)
      const singleSource = resolvedSources && resolvedSources.length === 1 ? resolvedSources[0] : undefined;
      const results: EvidenceResult[] = items.map((item) => ({
        title: item.title,
        anchor: item.anchor,
        snippet: item.summary ?? '',
        confidence: 'mid' as const,
        sourceType: mapKindToSourceType(item.kind),
        ...(singleSource ? { source: singleSource } : {}),
        ...(item.passages ? { passages: item.passages } : {}),
      }));
      return { results, degraded: false } satisfies Partial<EvidenceSearchResponse>;
    } catch {
      return {
        results: [],
        degraded: true,
        degradeReason: 'evidence_store_error',
      } satisfies Partial<EvidenceSearchResponse>;
    }
  });

  // F102 D-2/D-8: Memory status (AC-D8)
  app.get('/api/evidence/status', async () => {
    try {
      const db = (opts.evidenceStore as { getDb?: () => unknown }).getDb?.() as
        | { prepare: (sql: string) => { get: () => Record<string, unknown> } }
        | undefined;
      if (!db) return { backend: 'sqlite', healthy: false, reason: 'no_db' };

      const docCount = (db.prepare('SELECT count(*) AS c FROM evidence_docs').get() as { c: number }).c;
      const threadCount = (
        db.prepare("SELECT count(*) AS c FROM evidence_docs WHERE kind = 'thread'").get() as { c: number }
      ).c;
      const edgeCount = (db.prepare('SELECT count(*) AS c FROM edges').get() as { c: number }).c;
      const lastUpdated = (db.prepare('SELECT max(updated_at) AS t FROM evidence_docs').get() as { t: string | null })
        .t;

      // Passages count (may not exist in older schemas)
      let passageCount = 0;
      try {
        passageCount = (db.prepare('SELECT count(*) AS c FROM evidence_passages').get() as { c: number }).c;
      } catch {
        /* table may not exist */
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

      return {
        backend: 'sqlite',
        healthy: true,
        docs_count: docCount,
        threads_count: threadCount,
        passages_count: passageCount,
        edges_count: edgeCount,
        last_rebuild_at: lastUpdated,
        embedding_model: embeddingModel,
      };
    } catch {
      return { backend: 'sqlite', healthy: false, reason: 'query_error' };
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
};
