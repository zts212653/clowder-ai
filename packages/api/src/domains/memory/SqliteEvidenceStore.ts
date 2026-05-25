// F102: SQLite implementation of IEvidenceStore

import { basename, isAbsolute, relative, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { computeConsumptionPrior } from './consumption-prior.js';
import { type EntityMentionPassageHit, EntityRegistryStore } from './EntityRegistry.js';
import { EvidenceWriteQueue } from './evidence-write-queue.js';
import { ContradictionDetector } from './f163-contradiction-detector.js';
import { type F163Authority, freezeFlags, pathToAuthority } from './f163-types.js';
import { freezeF200Flags } from './f200-types.js';
import type {
  Edge,
  EntityMatch,
  EntityRecord,
  EvidenceItem,
  EvidenceKind,
  EvidenceSearchExecution,
  IEmbeddingService,
  IEvidenceStore,
  QueryEntityMatch,
  SearchExecutionMeta,
  SearchOptions,
} from './interfaces.js';
import {
  compareEvidenceItemsByLexicalBackfill,
  rankLexicalBackfillRows,
  splitLexicalBackfillWords,
} from './lexical-backfill.js';
import { applyMMR } from './mmr.js';
import { type PassageVectorStore, parsePassageVectorKey, passageVectorKey } from './PassageVectorStore.js';
import { computeRecencyDecay } from './recency-decay.js';
import { applyMigrations } from './schema.js';
import type { VectorStore } from './VectorStore.js';

// DF-8: asymmetric RRF weight for CJK queries — BM25/FTS5 has poor recall
// for Chinese text, so boost NN contributions to prevent suppression.
export const CJK_NN_WEIGHT = 1.5;
export function hasCJKCharacters(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

export interface PassageResult {
  docAnchor: string;
  passageId: string;
  content: string;
  speaker?: string;
  position?: number;
  /** BM25 relevance score from passage_fts (lower = more relevant) */
  rank?: number;
  /** AC-I7: ISO8601 timestamp of when the passage was created */
  createdAt?: string;
  /** AC-I8: surrounding passages within the context window */
  context?: PassageResult[];
}

export interface EmbedDeps {
  embedding: IEmbeddingService;
  vectorStore: VectorStore;
  passageVectorStore?: PassageVectorStore;
  mode: 'off' | 'shadow' | 'on';
}

export interface SqliteEvidenceStoreOptions {
  sourceRoot?: string;
  sourceRef?: string;
}

interface SearchFilterContext {
  effectiveKind?: EvidenceKind;
  excludeSessionAndThread: boolean;
  excludePackKnowledge: boolean;
  threadAnchor?: string;
  suppressBackstop: boolean;
}

export class SqliteEvidenceStore implements IEvidenceStore {
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private embedDeps?: EmbedDeps;
  private sourceRoot?: string;
  private sourceRef?: string;
  private entityRegistry?: EntityRegistryStore;
  /** F163: single-writer queue serializes all evidence.sqlite mutations */
  private readonly writeQueue = new EvidenceWriteQueue();

  constructor(dbPath: string, embedDeps?: EmbedDeps, options?: SqliteEvidenceStoreOptions) {
    this.dbPath = dbPath;
    this.embedDeps = embedDeps;
    this.sourceRoot = options?.sourceRoot ? resolve(options.sourceRoot) : undefined;
    this.sourceRef = options?.sourceRoot ? options.sourceRef : undefined;
  }

  /** @internal Allow late-binding of embed deps (factory sets after construction) */
  setEmbedDeps(deps: EmbedDeps): void {
    this.embedDeps = deps;
  }

  /** @internal Bind relative sourcePath values to the scanner/collection root that produced them. */
  setSourceRoot(sourceRoot?: string, sourceRef?: string): void {
    this.sourceRoot = sourceRoot ? resolve(sourceRoot) : undefined;
    this.sourceRef = sourceRoot ? sourceRef : undefined;
  }

  async initialize(): Promise<void> {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    applyMigrations(this.db);
    this.entityRegistry = new EntityRegistryStore(this.db);
  }

  async upsertEntities(entities: EntityRecord[]): Promise<void> {
    return this.writeQueue.enqueue(() => {
      this.ensureOpen();
      const changed = this.entityRegistry?.upsert(entities) ?? false;
      if (changed) this.entityRegistry?.refreshMentions();
    });
  }

  async getEntity(entityId: string): Promise<EntityRecord | null> {
    this.ensureOpen();
    return this.entityRegistry?.get(entityId) ?? null;
  }

  async resolveEntityAliases(query: string): Promise<QueryEntityMatch[]> {
    this.ensureOpen();
    return this.entityRegistry?.resolveQuery(query) ?? [];
  }

  async refreshEntityMentions(docAnchors?: string[]): Promise<void> {
    return this.writeQueue.enqueue(() => {
      this.ensureOpen();
      this.entityRegistry?.refreshMentions(docAnchors);
    });
  }

  async search(query: string, options?: SearchOptions): Promise<EvidenceItem[]> {
    return (await this.searchWithMeta(query, options)).items;
  }

  async searchWithMeta(query: string, options?: SearchOptions): Promise<EvidenceSearchExecution> {
    this.ensureOpen();
    const limit = options?.limit ?? 10;
    // P2 fix (砚砚): hybrid needs a wider BM25 candidate pool for meaningful RRF
    const bm25Pool = options?.mode === 'hybrid' ? Math.min(Math.max(limit * 4, 20), 100) : limit;
    const trimmed = query.trim();
    if (!trimmed) return { items: [], meta: { degraded: false } };
    const lexicalBackfillWords = splitLexicalBackfillWords(trimmed);
    const queryEntityMatches = this.entityRegistry?.resolveQuery(trimmed) ?? [];

    // Phase D: resolve scope → kind filter
    // scope='threads' → kind='thread' (P1 fix: was incorrectly mapped to 'session')
    // scope='sessions' → kind='session'
    // scope='docs'/'memory' → exclude session/thread digests, keep doc-backed discussions
    // scope='all' → no filter
    const effectiveKind =
      options?.kind ??
      (options?.scope === 'threads'
        ? ('thread' as EvidenceKind)
        : options?.scope === 'sessions'
          ? ('session' as EvidenceKind)
          : undefined);
    const excludeSessionAndThread = options?.scope === 'docs' || options?.scope === 'memory';
    // F129 AC-A10: exclude pack-knowledge from global search unless explicitly requested
    const excludePackKnowledge = effectiveKind !== 'pack-knowledge';
    // F148 Phase B (AC-B1): threadId filter — scope to a specific thread's evidence
    // Anchor convention: thread-{threadId} (e.g. thread-thread_abc for threadId="thread_abc")
    const threadAnchor = options?.threadId ? `thread-${options.threadId}` : undefined;
    // F163 Phase B (AC-B3): suppress backstop docs when compression is active
    let suppressBackstop = false;
    if (!options?.includeBackstop) {
      try {
        const { freezeFlags } = await import('./f163-types.js');
        suppressBackstop = freezeFlags().compression !== 'off';
      } catch {
        // f163-types not available — no suppression
      }
    }
    // ── Exact-anchor bypass ──────────────────────────────────────────
    // FTS5 unicode61 tokenizer splits "F042" → "F"+"042" and "ADR-005" → "ADR"+"005".
    // For anchor-shaped queries, do a direct lookup so precision isn't lost.
    const results: EvidenceItem[] = [];
    const seenAnchors = new Set<string>();

    let anchorSql = 'SELECT * FROM evidence_docs WHERE anchor = ? COLLATE NOCASE';
    const anchorParams: unknown[] = [trimmed];
    if (effectiveKind) {
      anchorSql += ' AND kind = ?';
      anchorParams.push(effectiveKind);
    }
    if (excludeSessionAndThread) {
      anchorSql += " AND kind != 'session' AND kind != 'thread'";
    }
    if (excludePackKnowledge) {
      anchorSql += " AND kind != 'pack-knowledge'";
    }
    if (options?.status) {
      anchorSql += ' AND status = ?';
      anchorParams.push(options.status);
    }
    if (options?.keywords?.length) {
      anchorSql += ` AND (${options.keywords.map(() => 'keywords LIKE ?').join(' OR ')})`;
      anchorParams.push(...options.keywords.map((kw) => `%"${kw}"%`));
    }
    if (threadAnchor) {
      anchorSql += ' AND anchor = ?';
      anchorParams.push(threadAnchor);
    }
    // F152 AC-A6: provenance tier filter
    if (options?.provenanceTier) {
      anchorSql += ' AND provenance_tier = ?';
      anchorParams.push(options.provenanceTier);
    }
    if (suppressBackstop) {
      anchorSql += " AND activation != 'backstop'";
    }
    // F093 Phase A (KD-16): world scope filter
    if (options?.worldId) {
      anchorSql += ' AND world_id = ?';
      anchorParams.push(options.worldId);
    }
    if (options?.sceneId) {
      anchorSql += ' AND scene_id = ?';
      anchorParams.push(options.sceneId);
    }
    const exactRow = this.db?.prepare(anchorSql).get(...anchorParams) as RowShape | undefined;
    if (exactRow) {
      results.push(rowToItem(exactRow));
      seenAnchors.add(exactRow.anchor);
    }

    // ── FTS5 full-text search ────────────────────────────────────────
    const ftsQuery = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(' ');

    if (ftsQuery) {
      try {
        let sql = `
				SELECT d.*, bm25(evidence_fts, 5.0, 1.0) AS rank
				FROM evidence_fts f
				JOIN evidence_docs d ON d.rowid = f.rowid
				WHERE evidence_fts MATCH ?
			`;
        const params: unknown[] = [ftsQuery];

        if (effectiveKind) {
          sql += ' AND d.kind = ?';
          params.push(effectiveKind);
        }
        if (excludeSessionAndThread) {
          sql += " AND d.kind != 'session' AND d.kind != 'thread'";
        }
        if (excludePackKnowledge) {
          sql += " AND d.kind != 'pack-knowledge'";
        }
        if (options?.status) {
          sql += ' AND d.status = ?';
          params.push(options.status);
        }
        if (options?.keywords?.length) {
          sql += ` AND (${options.keywords.map(() => 'd.keywords LIKE ?').join(' OR ')})`;
          params.push(...options.keywords.map((kw) => `%"${kw}"%`));
        }
        if (threadAnchor) {
          sql += ' AND d.anchor = ?';
          params.push(threadAnchor);
        }
        if (options?.dateFrom) {
          sql += ' AND d.updated_at >= ?';
          params.push(options.dateFrom);
        }
        if (options?.dateTo) {
          sql += ' AND d.updated_at <= ?';
          params.push(options.dateTo.length === 10 ? `${options.dateTo}T23:59:59` : options.dateTo);
        }
        // F152 AC-A6: provenance tier filter
        if (options?.provenanceTier) {
          sql += ' AND d.provenance_tier = ?';
          params.push(options.provenanceTier);
        }
        // F163 Phase B (AC-B3): backstop suppression
        if (suppressBackstop) {
          sql += " AND d.activation != 'backstop'";
        }
        // F093 Phase A (KD-16): world scope filter
        if (options?.worldId) {
          sql += ' AND d.world_id = ?';
          params.push(options.worldId);
        }
        if (options?.sceneId) {
          sql += ' AND d.scene_id = ?';
          params.push(options.sceneId);
        }

        // Superseded items sort last (KD-16), archive results deprioritized (P2 fix), authoritative first (F152 AC-A6, P1-2 NULL-safe)
        sql +=
          " ORDER BY (d.superseded_by IS NOT NULL), (d.source_path LIKE 'archive/%'), (CASE WHEN d.provenance_tier = 'authoritative' THEN 0 WHEN d.provenance_tier IS NOT NULL THEN 1 ELSE 2 END), rank";
        sql += ' LIMIT ?';
        params.push(bm25Pool);

        const rows = this.db?.prepare(sql).all(...params) as RowShape[];
        for (const row of rows) {
          if (!seenAnchors.has(row.anchor)) {
            results.push(rowToItem(row));
            seenAnchors.add(row.anchor);
          }
        }
      } catch {
        // FTS5 syntax error (malformed query) — degrade to anchor-only results
      }
    }

    // ── Lexical contains backfill: recover substring hits that unicode61 FTS misses ──
    if (lexicalBackfillWords.length > 0) {
      const containsConditions = lexicalBackfillWords.map(
        () => "(LOWER(title) LIKE ? OR LOWER(COALESCE(summary, '')) LIKE ? OR LOWER(COALESCE(keywords, '')) LIKE ?)",
      );
      let containsSql = `SELECT * FROM evidence_docs WHERE (${containsConditions.join(' OR ')})`;
      const containsParams: unknown[] = lexicalBackfillWords.flatMap((word) => {
        const pattern = `%${word}%`;
        return [pattern, pattern, pattern];
      });
      if (effectiveKind) {
        containsSql += ' AND kind = ?';
        containsParams.push(effectiveKind);
      }
      if (excludeSessionAndThread) {
        containsSql += " AND kind != 'session' AND kind != 'thread'";
      }
      if (excludePackKnowledge) {
        containsSql += " AND kind != 'pack-knowledge'";
      }
      if (options?.status) {
        containsSql += ' AND status = ?';
        containsParams.push(options.status);
      }
      if (options?.keywords?.length) {
        containsSql += ` AND (${options.keywords.map(() => 'keywords LIKE ?').join(' OR ')})`;
        containsParams.push(...options.keywords.map((kw) => `%"${kw}"%`));
      }
      if (threadAnchor) {
        containsSql += ' AND anchor = ?';
        containsParams.push(threadAnchor);
      }
      if (options?.worldId) {
        containsSql += ' AND world_id = ?';
        containsParams.push(options.worldId);
      }
      if (options?.sceneId) {
        containsSql += ' AND scene_id = ?';
        containsParams.push(options.sceneId);
      }
      if (options?.dateFrom) {
        containsSql += ' AND updated_at >= ?';
        containsParams.push(options.dateFrom);
      }
      if (options?.dateTo) {
        containsSql += ' AND updated_at <= ?';
        containsParams.push(options.dateTo.length === 10 ? `${options.dateTo}T23:59:59` : options.dateTo);
      }
      if (options?.provenanceTier) {
        containsSql += ' AND provenance_tier = ?';
        containsParams.push(options.provenanceTier);
      }
      // F163 Phase B (AC-B3): backstop suppression
      if (suppressBackstop) {
        containsSql += " AND activation != 'backstop'";
      }
      try {
        const containsRows = this.db?.prepare(containsSql).all(...containsParams) as RowShape[];
        const { rows: rankedRows, signals } = rankLexicalBackfillRows(containsRows, lexicalBackfillWords);
        for (const row of rankedRows) {
          if (!seenAnchors.has(row.anchor)) {
            results.push(rowToItem(row));
            seenAnchors.add(row.anchor);
          }
        }
        if (signals.size > 0) {
          results.sort((a, b) => compareEvidenceItemsByLexicalBackfill(a, b, signals, exactRow?.anchor));
        }
      } catch {
        // substring backfill failed — continue with existing results
      }
    }

    const entityMentionDocs = this.hydrateEntityMentionDocs(queryEntityMatches, options, bm25Pool, {
      effectiveKind,
      excludeSessionAndThread,
      excludePackKnowledge,
      threadAnchor,
      suppressBackstop,
    });
    for (const item of entityMentionDocs.items) {
      if (!seenAnchors.has(item.anchor)) {
        results.push(item);
        seenAnchors.add(item.anchor);
      }
    }

    if (options?.depth === 'raw') {
      const rawResult = await this.rawPassageSearch(
        query,
        results,
        limit,
        options,
        queryEntityMatches,
        entityMentionDocs.matchesByAnchor,
      );
      return {
        items: this.enrichWithDrillDown(rawResult.items, undefined, options, trimmed),
        meta: rawResult.meta,
      };
    }

    // ── F163: Post-retrieval authority boost (fail-open: Task 11) ──
    try {
      applyAuthorityBoost(results);
    } catch {
      // Kill-switch: boost failure → continue with original ranking
    }

    // P2 R2 fix (砚砚): keep full BM25 candidate pool for hybrid RRF,
    // only slice to limit for lexical/fallback returns
    const lexicalCandidates = results.slice(0, bm25Pool);
    const lexicalResults = results.slice(0, limit);

    // ── Mode-based retrieval (KD-44: three independent paths) ──────
    const searchMode = options?.mode ?? 'lexical';

    // G-4: all paths go through enrichWithDrillDown before returning
    if (searchMode === 'lexical') {
      return {
        items: this.enrichWithDrillDown(
          this.attachEntityMatches(lexicalResults, entityMentionDocs.matchesByAnchor),
          undefined,
          options,
          trimmed,
        ),
        meta: { degraded: false },
      };
    }

    if (searchMode === 'semantic') {
      const embeddingAvailable = await this.isEmbeddingAvailable();
      if (!embeddingAvailable) {
        return {
          items: this.enrichWithDrillDown(
            this.attachEntityMatches(lexicalResults, entityMentionDocs.matchesByAnchor),
            undefined,
            options,
            trimmed,
          ),
          meta: { degraded: false },
        };
      }
      try {
        const semanticItems = await this.semanticNNSearch(query, limit, options, suppressBackstop);
        return {
          items: this.enrichWithDrillDown(
            this.attachEntityMatches(
              this.mergeEntityResults(entityMentionDocs.items, semanticItems, limit),
              entityMentionDocs.matchesByAnchor,
            ),
            undefined,
            options,
            trimmed,
          ),
          meta: { degraded: false },
        };
      } catch {
        return {
          items: this.enrichWithDrillDown(
            this.attachEntityMatches(lexicalResults, entityMentionDocs.matchesByAnchor),
            undefined,
            options,
            trimmed,
          ),
          meta: { degraded: false },
        };
      }
    }

    if (searchMode === 'hybrid') {
      const embeddingAvailable = await this.isEmbeddingAvailable();
      if (!embeddingAvailable) {
        return {
          items: this.enrichWithDrillDown(
            this.attachEntityMatches(lexicalResults, entityMentionDocs.matchesByAnchor),
            undefined,
            options,
            trimmed,
          ),
          meta: { degraded: false },
        };
      }
      try {
        const f200Pool = freezeF200Flags().consumptionRerank !== 'off' ? limit * 3 : limit;
        const hybridItems = await this.hybridRRFSearch(query, lexicalCandidates, f200Pool, options, suppressBackstop);
        return {
          items: this.enrichWithDrillDown(
            this.attachEntityMatches(
              this.mergeEntityResults(entityMentionDocs.items, hybridItems, f200Pool),
              entityMentionDocs.matchesByAnchor,
            ),
            limit,
            options,
            trimmed,
          ),
          meta: { degraded: false },
        };
      } catch {
        return {
          items: this.enrichWithDrillDown(
            this.attachEntityMatches(lexicalResults, entityMentionDocs.matchesByAnchor),
            undefined,
            options,
            trimmed,
          ),
          meta: { degraded: false },
        };
      }
    }

    return {
      items: this.enrichWithDrillDown(
        this.attachEntityMatches(lexicalResults, entityMentionDocs.matchesByAnchor),
        undefined,
        options,
        trimmed,
      ),
      meta: { degraded: false },
    };
  }

  private async rawPassageSearch(
    query: string,
    baseResults: EvidenceItem[],
    limit: number,
    options: SearchOptions,
    queryEntityMatches: QueryEntityMatch[],
    entityMatchesByAnchor: Map<string, EntityMatch[]>,
  ): Promise<EvidenceSearchExecution> {
    if (options.scope && options.scope !== 'all' && options.scope !== 'threads') {
      return {
        items: this.attachEntityMatches(this.rankRawResults(baseResults, limit), entityMatchesByAnchor),
        meta: { degraded: false },
      };
    }

    const mode = options.mode ?? 'lexical';
    const pool = Math.min(Math.max(limit * 4, 20), 100);
    const timeFilter = { dateFrom: options.dateFrom, dateTo: options.dateTo };
    const lexical = (): PassageResult[] => this.searchPassages(query, pool, timeFilter);

    let passages: PassageResult[];
    let meta: SearchExecutionMeta = { degraded: false };
    if (mode === 'semantic') {
      if (!(await this.isPassageEmbeddingAvailable())) {
        passages = lexical();
        meta = {
          degraded: true,
          degradeReason: 'passage_embedding_unavailable',
          effectiveMode: 'lexical',
        };
      } else {
        try {
          passages = await this.semanticPassageNNSearch(query, pool, options);
        } catch {
          passages = lexical();
          meta = {
            degraded: true,
            degradeReason: 'passage_vector_search_error',
            effectiveMode: 'lexical',
          };
        }
      }
    } else if (mode === 'hybrid') {
      if (!(await this.isPassageEmbeddingAvailable())) {
        passages = lexical();
        meta = {
          degraded: true,
          degradeReason: 'passage_embedding_unavailable',
          effectiveMode: 'lexical',
        };
      } else {
        try {
          passages = await this.hybridPassageRRFSearch(query, lexical(), pool, options);
        } catch {
          passages = lexical();
          meta = {
            degraded: true,
            degradeReason: 'passage_vector_search_error',
            effectiveMode: 'lexical',
          };
        }
      }
    } else {
      passages = lexical();
    }

    const entityPassageHits = this.entityRegistry?.findMentionPassages(queryEntityMatches, pool, {
      threadId: options.threadId,
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
    });
    const entityPassages = entityPassageHits?.passages.map((p) => this.entityHitToPassageResult(p)) ?? [];
    const mergedEntityMatches = mergeEntityMatchMaps(entityMatchesByAnchor, entityPassageHits?.matchesByAnchor);
    const mergedPassages = mergePassageResults(entityPassages, passages);
    return {
      items: this.attachEntityMatches(
        this.hydratePassageResults(baseResults, mergedPassages, limit, options),
        mergedEntityMatches,
      ),
      meta,
    };
  }

  private hydrateEntityMentionDocs(
    queryEntityMatches: QueryEntityMatch[],
    options: SearchOptions | undefined,
    limit: number,
    filters: SearchFilterContext,
  ): { items: EvidenceItem[]; matchesByAnchor: Map<string, EntityMatch[]> } {
    const mentionHits = this.entityRegistry?.findMentionAnchors(queryEntityMatches, limit, {
      kind: filters.effectiveKind,
      excludeSessionAndThread: filters.excludeSessionAndThread,
      excludePackKnowledge: filters.excludePackKnowledge,
      status: options?.status,
      keywords: options?.keywords,
      anchor: filters.threadAnchor,
      dateFrom: options?.dateFrom,
      dateTo: options?.dateTo,
      worldId: options?.worldId,
      sceneId: options?.sceneId,
      provenanceTier: options?.provenanceTier,
      suppressBackstop: filters.suppressBackstop,
    });
    if (!mentionHits || mentionHits.anchors.length === 0 || !this.db) {
      return { items: [], matchesByAnchor: new Map() };
    }

    const placeholders = mentionHits.anchors.map(() => '?').join(',');
    let sql = `SELECT * FROM evidence_docs WHERE anchor IN (${placeholders})`;
    const params: unknown[] = [...mentionHits.anchors];

    if (filters.effectiveKind) {
      sql += ' AND kind = ?';
      params.push(filters.effectiveKind);
    }
    if (filters.excludeSessionAndThread) {
      sql += " AND kind != 'session' AND kind != 'thread'";
    }
    if (filters.excludePackKnowledge) {
      sql += " AND kind != 'pack-knowledge'";
    }
    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    if (options?.keywords?.length) {
      sql += ` AND (${options.keywords.map(() => 'keywords LIKE ?').join(' OR ')})`;
      params.push(...options.keywords.map((kw) => `%"${kw}"%`));
    }
    if (filters.threadAnchor) {
      sql += ' AND anchor = ?';
      params.push(filters.threadAnchor);
    }
    if (options?.dateFrom) {
      sql += ' AND updated_at >= ?';
      params.push(options.dateFrom);
    }
    if (options?.dateTo) {
      sql += ' AND updated_at <= ?';
      params.push(options.dateTo.length === 10 ? `${options.dateTo}T23:59:59` : options.dateTo);
    }
    if (options?.worldId) {
      sql += ' AND world_id = ?';
      params.push(options.worldId);
    }
    if (options?.sceneId) {
      sql += ' AND scene_id = ?';
      params.push(options.sceneId);
    }
    if (options?.provenanceTier) {
      sql += ' AND provenance_tier = ?';
      params.push(options.provenanceTier);
    }
    if (filters.suppressBackstop) {
      sql += " AND activation != 'backstop'";
    }

    const rows = this.db.prepare(sql).all(...params) as RowShape[];
    const rowMap = new Map(rows.map((row) => [row.anchor, row]));
    const items = mentionHits.anchors
      .map((anchor) => rowMap.get(anchor))
      .filter((row): row is RowShape => Boolean(row))
      .map((row) => rowToItem(row));
    return { items, matchesByAnchor: mentionHits.matchesByAnchor };
  }

  private attachEntityMatches(items: EvidenceItem[], matchesByAnchor: Map<string, EntityMatch[]>): EvidenceItem[] {
    if (matchesByAnchor.size === 0) return items;
    for (const item of items) {
      const matches = dedupeEntityMatches(matchesByAnchor.get(item.anchor) ?? []);
      if (matches.length > 0) item.entityMatches = matches;
    }
    return items;
  }

  private mergeEntityResults(entityItems: EvidenceItem[], items: EvidenceItem[], limit: number): EvidenceItem[] {
    if (entityItems.length === 0) return items.slice(0, limit);
    const out: EvidenceItem[] = [];
    const seen = new Set<string>();
    const entityCap = items.length > 0 ? Math.max(1, Math.ceil(limit / 2)) : limit;
    for (const item of entityItems.slice(0, entityCap)) {
      if (seen.has(item.anchor)) continue;
      seen.add(item.anchor);
      out.push(item);
      if (out.length >= limit) break;
    }
    for (const item of items) {
      if (seen.has(item.anchor)) continue;
      seen.add(item.anchor);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out.slice(0, limit);
  }

  private entityHitToPassageResult(hit: EntityMentionPassageHit): PassageResult {
    return {
      docAnchor: hit.docAnchor,
      passageId: hit.passageId,
      content: hit.content,
      speaker: hit.speaker,
      position: hit.position,
      createdAt: hit.createdAt,
    };
  }

  private async isEmbeddingAvailable(): Promise<boolean> {
    const deps = this.embedDeps;
    if (!deps || deps.mode !== 'on') return false;
    try {
      await deps.embedding.reprobeIfNeeded();
    } catch {
      return false;
    }
    return deps.embedding.isReady();
  }

  private async isPassageEmbeddingAvailable(): Promise<boolean> {
    const deps = this.embedDeps;
    if (!deps?.passageVectorStore || deps.mode !== 'on') return false;
    try {
      await deps.embedding.reprobeIfNeeded();
    } catch {
      return false;
    }
    return deps.embedding.isReady();
  }

  private async semanticPassageNNSearch(
    query: string,
    limit: number,
    options?: SearchOptions,
  ): Promise<PassageResult[]> {
    const queryVec = await this.embedDeps!.embedding.embed([query]);
    const nnResults = this.embedDeps!.passageVectorStore!.search(queryVec[0], limit);
    return this.hydratePassageVectorHits(nnResults, options);
  }

  private async hybridPassageRRFSearch(
    query: string,
    lexicalPassages: PassageResult[],
    limit: number,
    options?: SearchOptions,
  ): Promise<PassageResult[]> {
    const semanticPassages = await this.semanticPassageNNSearch(query, limit, options);
    const rrfK = 60;
    const nnWeight = hasCJKCharacters(query) ? CJK_NN_WEIGHT : 1.0;
    const scores = new Map<string, number>();
    const passageMap = new Map<string, PassageResult>();

    for (let i = 0; i < lexicalPassages.length; i++) {
      const passage = lexicalPassages[i];
      const key = passageVectorKey(passage.docAnchor, passage.passageId);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (rrfK + i));
      passageMap.set(key, passage);
    }

    for (let i = 0; i < semanticPassages.length; i++) {
      const passage = semanticPassages[i];
      const key = passageVectorKey(passage.docAnchor, passage.passageId);
      scores.set(key, (scores.get(key) ?? 0) + nnWeight / (rrfK + i));
      passageMap.set(key, passage);
    }

    return [...scores.keys()]
      .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
      .map((key) => passageMap.get(key))
      .filter((p): p is PassageResult => Boolean(p))
      .slice(0, limit);
  }

  private hydratePassageVectorHits(
    hits: Array<{ passageKey: string; distance: number }>,
    options?: SearchOptions,
  ): PassageResult[] {
    if (!this.db || hits.length === 0) return [];

    const parsed = hits
      .map((hit) => {
        try {
          return { ...parsePassageVectorKey(hit.passageKey), passageKey: hit.passageKey, distance: hit.distance };
        } catch {
          return null;
        }
      })
      .filter((hit): hit is { docAnchor: string; passageId: string; passageKey: string; distance: number } =>
        Boolean(hit),
      );
    if (parsed.length === 0) return [];

    const clauses = parsed.map(() => '(doc_anchor = ? AND passage_id = ?)').join(' OR ');
    const params: unknown[] = parsed.flatMap((p) => [p.docAnchor, p.passageId]);
    let sql = `SELECT doc_anchor, passage_id, content, speaker, position, created_at FROM evidence_passages WHERE (${clauses})`;

    if (options?.threadId) {
      sql += ' AND doc_anchor = ?';
      params.push(`thread-${options.threadId}`);
    }
    if (options?.dateFrom) {
      sql += ' AND created_at >= ?';
      params.push(options.dateFrom);
    }
    if (options?.dateTo) {
      sql += ' AND created_at <= ?';
      params.push(options.dateTo.length === 10 ? `${options.dateTo}T23:59:59` : options.dateTo);
    }

    const rows = this.db.prepare(sql).all(...params) as Array<{
      doc_anchor: string;
      passage_id: string;
      content: string;
      speaker: string | null;
      position: number | null;
      created_at: string | null;
    }>;
    const rowMap = new Map(rows.map((r) => [passageVectorKey(r.doc_anchor, r.passage_id), r]));

    const passages: PassageResult[] = [];
    for (let index = 0; index < parsed.length; index++) {
      const hit = parsed[index];
      const row = rowMap.get(hit.passageKey);
      if (!row) continue;
      passages.push({
        docAnchor: row.doc_anchor,
        passageId: row.passage_id,
        content: row.content,
        speaker: row.speaker ?? undefined,
        position: row.position ?? undefined,
        rank: hit.distance ?? index,
        createdAt: row.created_at ?? undefined,
      });
    }
    return passages;
  }

  private hydratePassageResults(
    baseResults: EvidenceItem[],
    passages: PassageResult[],
    limit: number,
    options?: SearchOptions,
  ): EvidenceItem[] {
    const results = [...baseResults];
    const threadAnchor = options?.threadId ? `thread-${options.threadId}` : undefined;
    const passageOrder = new Map<string, number>();
    const passagesByAnchor = new Map<string, PassageResult[]>();
    const withContext = this.attachPassageContext(passages, options?.contextWindow);

    for (let index = 0; index < withContext.length; index++) {
      const passage = withContext[index];
      if (threadAnchor && passage.docAnchor !== threadAnchor) continue;
      const arr = passagesByAnchor.get(passage.docAnchor) ?? [];
      arr.push(passage);
      passagesByAnchor.set(passage.docAnchor, arr);
      if (!passageOrder.has(passage.docAnchor)) passageOrder.set(passage.docAnchor, index);
    }

    for (const [anchor, pList] of passagesByAnchor) {
      let item = results.find((r) => r.anchor === anchor);
      if (!item) {
        const parentDoc = this.db?.prepare('SELECT * FROM evidence_docs WHERE anchor = ?').get(anchor) as
          | RowShape
          | undefined;
        if (parentDoc) {
          item = rowToItem(parentDoc);
          item.summary = `[passage match] ${pList[0].speaker ? `${pList[0].speaker}: ` : ''}${pList[0].content.slice(0, 200)}`;
          results.push(item);
        }
      }
      if (item) item.passages = pList.map((p) => this.toEvidencePassage(p));
    }

    return this.rankRawResults(results, limit, passageOrder);
  }

  private attachPassageContext(passages: PassageResult[], contextWindow?: number): PassageResult[] {
    if (!contextWindow || contextWindow <= 0 || !this.db) return passages;
    const ctxStmt = this.db.prepare(
      `SELECT doc_anchor, passage_id, content, speaker, position, created_at
       FROM evidence_passages
       WHERE doc_anchor = ? AND position BETWEEN ? AND ? AND passage_id != ?
       ORDER BY position`,
    );

    return passages.map((passage) => {
      if (passage.position == null) return passage;
      const ctxRows = ctxStmt.all(
        passage.docAnchor,
        passage.position - contextWindow,
        passage.position + contextWindow,
        passage.passageId,
      ) as Array<{
        doc_anchor: string;
        passage_id: string;
        content: string;
        speaker: string | null;
        position: number | null;
        created_at: string | null;
      }>;
      return {
        ...passage,
        context: ctxRows.map((c) => ({
          docAnchor: c.doc_anchor,
          passageId: c.passage_id,
          content: c.content,
          speaker: c.speaker ?? undefined,
          position: c.position ?? undefined,
          createdAt: c.created_at ?? undefined,
        })),
      };
    });
  }

  private toEvidencePassage(passage: PassageResult): NonNullable<EvidenceItem['passages']>[number] {
    const threadId = passage.docAnchor.startsWith('thread-') ? passage.docAnchor.slice('thread-'.length) : undefined;
    const messageId = passage.passageId.startsWith('msg-') ? passage.passageId.slice('msg-'.length) : undefined;
    return {
      docAnchor: passage.docAnchor,
      passageId: passage.passageId,
      content: passage.content,
      speaker: passage.speaker,
      createdAt: passage.createdAt,
      threadId,
      messageId,
      ...(passage.context
        ? {
            context: passage.context.map((c) => {
              const ctxThreadId = c.docAnchor.startsWith('thread-') ? c.docAnchor.slice('thread-'.length) : undefined;
              const ctxMessageId = c.passageId.startsWith('msg-') ? c.passageId.slice('msg-'.length) : undefined;
              return {
                docAnchor: c.docAnchor,
                passageId: c.passageId,
                content: c.content,
                speaker: c.speaker,
                createdAt: c.createdAt,
                threadId: ctxThreadId,
                messageId: ctxMessageId,
              };
            }),
          }
        : {}),
    };
  }

  private rankRawResults(
    results: EvidenceItem[],
    limit: number,
    passageOrder: Map<string, number> = new Map(),
  ): EvidenceItem[] {
    const originalOrder = new Map(results.map((item, index) => [item.anchor, index]));
    results.sort((a, b) => {
      const aHas = a.passages?.length ? 1 : 0;
      const bHas = b.passages?.length ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      if (aHas && bHas) {
        return (
          (passageOrder.get(a.anchor) ?? Number.MAX_SAFE_INTEGER) -
          (passageOrder.get(b.anchor) ?? Number.MAX_SAFE_INTEGER)
        );
      }
      return (
        (originalOrder.get(a.anchor) ?? Number.MAX_SAFE_INTEGER) -
        (originalOrder.get(b.anchor) ?? Number.MAX_SAFE_INTEGER)
      );
    });
    return results.slice(0, limit);
  }

  /**
   * G-4: Enrich search results with drill-down hints for thread/session items.
   * Tells the cat what MCP tool to use to see full details.
   */
  private enrichWithDrillDown(
    results: EvidenceItem[],
    targetLimit?: number,
    options?: SearchOptions,
    query = '',
  ): EvidenceItem[] {
    try {
      if (this.db) applyConsumptionRerank(results, this.db, targetLimit);
    } catch {
      // F200 kill-switch: rerank failure → continue with existing ranking
    }
    if (targetLimit && results.length > targetLimit) results.length = targetLimit;
    annotateMatchReasons(results, query, options?.explain);
    for (const item of results) {
      const primaryPassage = item.passages?.find((p) => p.threadId && p.messageId);
      if (primaryPassage?.threadId && primaryPassage.messageId) {
        item.drillDown = {
          tool: 'cat_cafe_get_thread_context',
          params: {
            threadId: primaryPassage.threadId,
            messageId: primaryPassage.messageId,
            before: '3',
            after: '3',
          },
          hint: `打开原文窗口：get_thread_context(threadId="${primaryPassage.threadId}", messageId="${primaryPassage.messageId}", before=3, after=3)`,
        };
      } else if (item.kind === 'thread' && item.anchor.startsWith('thread-')) {
        const threadId = item.anchor.replace('thread-', '');
        item.drillDown = {
          tool: 'cat_cafe_get_thread_context',
          params: { threadId },
          hint: `查看完整对话：get_thread_context(threadId="${threadId}")`,
        };
      } else if (item.kind === 'session' && item.anchor.startsWith('session-')) {
        const sessionId = item.anchor.replace('session-', '');
        item.drillDown = {
          tool: 'cat_cafe_read_session_digest',
          params: { sessionId },
          hint: `查看 session 摘要：read_session_digest(sessionId="${sessionId}")`,
        };
      } else if (item.sourcePath) {
        const filePath = this.resolveSourcePathForDrillDown(item.sourcePath);
        if (filePath) {
          item.drillDown = {
            tool: 'cat_cafe_read_file_slice',
            params: { path: filePath, startLine: '1', endLine: '120' },
            hint: `打开文件切片：read_file_slice(path="${filePath}", startLine=1, endLine=120)`,
          };
        }
      }
    }
    return results;
  }

  private resolveSourcePathForDrillDown(sourcePath: string): string | null {
    if (!this.sourceRoot) return null;
    const resolved = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(this.sourceRoot, sourcePath);
    const rel = relative(this.sourceRoot, resolved);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    const publicRel = rel
      .split(/[\\/]+/)
      .filter(Boolean)
      .join('/');
    if (!this.sourceRef) {
      return basename(this.sourceRoot) === 'docs' && !publicRel.startsWith('docs/') ? `docs/${publicRel}` : publicRel;
    }
    const encodedPath = publicRel.split('/').map(encodeURIComponent).join('/');
    return `cat-cafe://collection/${encodeURIComponent(this.sourceRef)}/${encodedPath}`;
  }

  /**
   * KD-44: Pure vector nearest-neighbor search (mode=semantic).
   * Skips BM25 entirely — queries evidence_vectors directly.
   * Hydrates results from evidence_docs in a single IN(...) query (砚砚: no N+1).
   */
  private async semanticNNSearch(
    query: string,
    limit: number,
    options?: SearchOptions,
    suppressBackstop?: boolean,
  ): Promise<EvidenceItem[]> {
    const pool = Math.min(Math.max(limit * 4, 20), 100); // 砚砚: generous pool, cap 100
    const queryVec = await this.embedDeps!.embedding.embed([query]);
    const nnResults = this.embedDeps!.vectorStore.search(queryVec[0], pool);
    if (nnResults.length === 0) return [];

    // Hydrate from evidence_docs in one query (no N+1)
    const anchors = nnResults.map((r) => r.anchor);
    const placeholders = anchors.map(() => '?').join(',');
    let sql = `SELECT * FROM evidence_docs WHERE anchor IN (${placeholders})`;
    const params: unknown[] = [...anchors];

    // Apply ALL SearchOptions filters (P1 fix: semantic must respect status/keywords too)
    const effectiveKind =
      options?.kind ??
      (options?.scope === 'threads' ? 'thread' : options?.scope === 'sessions' ? 'session' : undefined);
    const excludeSessionAndThread = options?.scope === 'docs' || options?.scope === 'memory';
    const excludePackKnowledge = effectiveKind !== 'pack-knowledge';
    if (effectiveKind) {
      sql += ' AND kind = ?';
      params.push(effectiveKind);
    }
    if (excludeSessionAndThread) {
      sql += " AND kind != 'session' AND kind != 'thread'";
    }
    if (excludePackKnowledge) {
      sql += " AND kind != 'pack-knowledge'";
    }
    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }
    if (options?.keywords?.length) {
      sql += ` AND (${options.keywords.map(() => 'keywords LIKE ?').join(' OR ')})`;
      params.push(...options.keywords.map((kw) => `%"${kw}"%`));
    }
    // R2-P1 fix: threadId filter for semantic search
    const semanticThreadAnchor = options?.threadId ? `thread-${options.threadId}` : undefined;
    if (semanticThreadAnchor) {
      sql += ' AND anchor = ?';
      params.push(semanticThreadAnchor);
    }
    if (options?.worldId) {
      sql += ' AND world_id = ?';
      params.push(options.worldId);
    }
    if (options?.sceneId) {
      sql += ' AND scene_id = ?';
      params.push(options.sceneId);
    }
    // P1-3 fix: provenanceTier filter for semantic search
    if (options?.provenanceTier) {
      sql += ' AND provenance_tier = ?';
      params.push(options.provenanceTier);
    }
    if (suppressBackstop) {
      sql += " AND activation != 'backstop'";
    }

    const rows = this.db?.prepare(sql).all(...params) as RowShape[];
    const docMap = new Map(rows.map((r) => [r.anchor, rowToItem(r)]));

    // Return in NN distance order, filtered by what passed scope/kind
    return nnResults
      .filter((r) => docMap.has(r.anchor))
      .map((r) => docMap.get(r.anchor)!)
      .slice(0, limit);
  }

  /**
   * KD-44: Hybrid search — BM25 + vector NN dual-path recall → RRF fusion.
   * 砚砚 R5: pool = max(limit*4, 20) cap 100, RRF k=60.
   */
  private async hybridRRFSearch(
    query: string,
    lexicalResults: EvidenceItem[],
    limit: number,
    options?: SearchOptions,
    suppressBackstop?: boolean,
  ): Promise<EvidenceItem[]> {
    const pool = Math.min(Math.max(limit * 4, 20), 100);
    const queryVec = await this.embedDeps!.embedding.embed([query]);
    const nnResults = this.embedDeps!.vectorStore.search(queryVec[0], pool);

    // RRF fusion: score = Σ 1/(k + rank_i), k=60
    const RRF_K = 60;
    const scores = new Map<string, number>();
    // DF-8: boost NN weight for CJK queries (BM25 has poor CJK recall)
    const nnWeight = hasCJKCharacters(query) ? CJK_NN_WEIGHT : 1.0;

    // BM25 ranks
    for (let i = 0; i < lexicalResults.length; i++) {
      const anchor = lexicalResults[i].anchor;
      scores.set(anchor, (scores.get(anchor) ?? 0) + 1 / (RRF_K + i));
    }

    // NN ranks (weighted for CJK)
    for (let i = 0; i < nnResults.length; i++) {
      const anchor = nnResults[i].anchor;
      scores.set(anchor, (scores.get(anchor) ?? 0) + nnWeight / (RRF_K + i));
    }

    // Collect all unique anchors, hydrate missing ones from DB
    const allAnchors = [...scores.keys()];
    const lexicalMap = new Map(lexicalResults.map((r) => [r.anchor, r]));

    // P1 fix: hydrate missing NN anchors WITH filters (status/kind/keywords)
    const missingAnchors = allAnchors.filter((a) => !lexicalMap.has(a));
    if (missingAnchors.length > 0 && this.db) {
      const placeholders = missingAnchors.map(() => '?').join(',');
      let sql = `SELECT * FROM evidence_docs WHERE anchor IN (${placeholders})`;
      const params: unknown[] = [...missingAnchors];

      // Apply SearchOptions filters (same as semanticNNSearch)
      const effectiveKind =
        options?.kind ??
        (options?.scope === 'threads' ? 'thread' : options?.scope === 'sessions' ? 'session' : undefined);
      const excludeSessionAndThread = options?.scope === 'docs' || options?.scope === 'memory';
      const excludePackKnowledge = effectiveKind !== 'pack-knowledge';
      if (effectiveKind) {
        sql += ' AND kind = ?';
        params.push(effectiveKind);
      }
      if (excludeSessionAndThread) {
        sql += " AND kind != 'session' AND kind != 'thread'";
      }
      if (excludePackKnowledge) {
        sql += " AND kind != 'pack-knowledge'";
      }
      if (options?.status) {
        sql += ' AND status = ?';
        params.push(options.status);
      }
      if (options?.keywords?.length) {
        sql += ` AND (${options.keywords.map(() => 'keywords LIKE ?').join(' OR ')})`;
        params.push(...options.keywords.map((kw) => `%"${kw}"%`));
      }
      // R2-P1 fix: threadId filter for hybrid NN hydrate
      const hybridThreadAnchor = options?.threadId ? `thread-${options.threadId}` : undefined;
      if (hybridThreadAnchor) {
        sql += ' AND anchor = ?';
        params.push(hybridThreadAnchor);
      }
      if (options?.worldId) {
        sql += ' AND world_id = ?';
        params.push(options.worldId);
      }
      if (options?.sceneId) {
        sql += ' AND scene_id = ?';
        params.push(options.sceneId);
      }
      // P1-3 fix: provenanceTier filter for hybrid NN hydrate
      if (options?.provenanceTier) {
        sql += ' AND provenance_tier = ?';
        params.push(options.provenanceTier);
      }
      if (suppressBackstop) {
        sql += " AND activation != 'backstop'";
      }

      const rows = this.db.prepare(sql).all(...params) as RowShape[];
      for (const row of rows) {
        lexicalMap.set(row.anchor, rowToItem(row));
      }
    }

    // Sort by RRF score descending, return top limit
    return allAnchors
      .filter((a) => lexicalMap.has(a))
      .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
      .map((a) => lexicalMap.get(a)!)
      .slice(0, limit);
  }

  async upsert(items: EvidenceItem[]): Promise<void> {
    return this.writeQueue.enqueue(async () => {
      this.ensureOpen();
      const db = this.db;
      if (!db) {
        throw new Error('Evidence store is closed');
      }

      // F163 Phase C (AC-C1): write-time contradiction detection
      const flags = freezeFlags();
      if (flags.contradictionDetection !== 'off') {
        const detector = new ContradictionDetector(this);
        for (const item of items) {
          if (!item.contradicts) {
            const hits = await detector.check({
              title: item.title,
              summary: item.summary,
              kind: item.kind,
            });
            const filtered = hits.filter((h) => h.anchor !== item.anchor);
            if (filtered.length > 0) {
              item.contradicts = filtered.map((h) => h.anchor);
            }
          }
        }
      }

      // F163 Phase B (AC-B5): cascade compression guard
      // If any item is a summary (summaryOfAnchor set), verify none of its
      // sourceIds reference docs that are themselves summaries.
      for (const item of items) {
        if (item.summaryOfAnchor && item.sourceIds?.length) {
          const placeholders = item.sourceIds.map(() => '?').join(',');
          const cascadeHits = db
            .prepare(
              `SELECT anchor FROM evidence_docs
               WHERE anchor IN (${placeholders}) AND summary_of_anchor IS NOT NULL`,
            )
            .all(...item.sourceIds) as { anchor: string }[];
          if (cascadeHits.length > 0) {
            const hitAnchors = cascadeHits.map((r) => r.anchor).join(', ');
            throw new Error(`cascade compression prohibited: source(s) [${hitAnchors}] are already summaries`);
          }
        }
      }

      const stmt = db.prepare(`
				INSERT OR REPLACE INTO evidence_docs
				(anchor, kind, status, title, summary, keywords, source_path, source_hash,
				 superseded_by, materialized_from, updated_at, pack_id, provenance_tier, provenance_source, generalizable,
				 authority, activation, verified_at,
				 source_ids, summary_of_anchor, compression_rationale,
				 contradicts, invalid_at, review_cycle_days,
				 world_id, scene_id, first_indexed_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);
      const lookupFirstIndexed = db.prepare('SELECT first_indexed_at FROM evidence_docs WHERE anchor = ?');

      const tx = db.transaction((items: EvidenceItem[]) => {
        for (const item of items) {
          const existing = lookupFirstIndexed.get(item.anchor) as { first_indexed_at: number } | undefined;
          const firstIndexedAt = existing != null ? existing.first_indexed_at : Date.now();
          stmt.run(
            item.anchor,
            item.kind,
            item.status,
            item.title,
            item.summary ?? null,
            item.keywords ? JSON.stringify(item.keywords) : null,
            item.sourcePath ?? null,
            item.sourceHash ?? null,
            item.supersededBy ?? null,
            item.materializedFrom ?? null,
            item.updatedAt,
            item.packId ?? null,
            item.provenance?.tier ?? null,
            item.provenance?.source ?? null,
            item.generalizable == null ? null : item.generalizable ? 1 : 0,
            item.authority ?? pathToAuthority(item.sourcePath ?? item.anchor),
            item.activation ?? 'query',
            item.verifiedAt ?? null,
            item.sourceIds ? JSON.stringify(item.sourceIds) : null,
            item.summaryOfAnchor ?? null,
            item.compressionRationale ?? null,
            item.contradicts ? JSON.stringify(item.contradicts) : null,
            item.invalidAt ?? null,
            item.reviewCycleDays ?? null,
            item.worldId ?? null,
            item.sceneId ?? null,
            firstIndexedAt,
          );
        }
      });

      tx(items);
      this.entityRegistry?.refreshMentions(items.map((item) => item.anchor));
    });
  }

  async deleteByAnchor(anchor: string): Promise<void> {
    return this.writeQueue.enqueue(() => {
      this.ensureOpen();
      this.db?.prepare('DELETE FROM evidence_docs WHERE anchor = ?').run(anchor);
    });
  }

  /** F129: Delete all evidence entries for a given pack_id */
  async deleteByPackId(packId: string): Promise<number> {
    return this.writeQueue.enqueue(() => {
      this.ensureOpen();
      const result = this.db?.prepare('DELETE FROM evidence_docs WHERE pack_id = ?').run(packId);
      return result?.changes ?? 0;
    });
  }

  removeBySourcePrefix(prefix: string): number {
    this.ensureOpen();
    const escaped = prefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const likePattern = escaped + '%';
    const anchors = (
      this.db?.prepare("SELECT anchor FROM evidence_docs WHERE source_path LIKE ? ESCAPE '\\'").all(likePattern) as
        | Array<{ anchor: string }>
        | undefined
    )?.map((r) => r.anchor);
    const result = this.db?.prepare("DELETE FROM evidence_docs WHERE source_path LIKE ? ESCAPE '\\'").run(likePattern);
    if (anchors?.length) {
      const CHUNK = 400;
      for (let i = 0; i < anchors.length; i += CHUNK) {
        const batch = anchors.slice(i, i + CHUNK);
        const ph = batch.map(() => '?').join(',');
        this.db
          ?.prepare(`DELETE FROM edges WHERE from_anchor IN (${ph}) OR to_anchor IN (${ph})`)
          .run(...batch, ...batch);
        try {
          this.db?.prepare(`DELETE FROM evidence_vectors WHERE anchor IN (${ph})`).run(...batch);
        } catch {
          // evidence_vectors (vec0) may not exist when embedding is disabled
        }
      }
    }
    return result?.changes ?? 0;
  }

  async getByAnchor(anchor: string): Promise<EvidenceItem | null> {
    this.ensureOpen();
    const row = this.db?.prepare('SELECT * FROM evidence_docs WHERE anchor = ? COLLATE NOCASE').get(anchor) as
      | RowShape
      | undefined;
    return row ? rowToItem(row) : null;
  }

  async health(): Promise<boolean> {
    try {
      if (!this.db || !this.db.open) return false;
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  /** Expose db for IndexBuilder and other internal consumers */
  getDb(): Database.Database {
    this.ensureOpen();
    return this.db!;
  }

  /** Serialize an arbitrary write through the single-writer queue (F163 AC-A5). */
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.writeQueue.enqueue(fn);
  }

  /**
   * F163 Phase B (AC-B2): Create a canonical summary and demote originals to backstop.
   * Validates: all source anchors exist, no cascade (source is not itself a summary).
   * Returns the generated summary anchor.
   */
  async createSummary(params: {
    sourceAnchors: string[];
    title: string;
    summary: string;
    rationale: string;
    kind?: EvidenceItem['kind'];
  }): Promise<string> {
    return this.writeQueue.enqueue(() => {
      this.ensureOpen();
      const db = this.db;
      if (!db) throw new Error('Evidence store is closed');

      // Validate all source anchors exist
      const placeholders = params.sourceAnchors.map(() => '?').join(',');
      const existing = db
        .prepare(`SELECT anchor, kind, summary_of_anchor FROM evidence_docs WHERE anchor IN (${placeholders})`)
        .all(...params.sourceAnchors) as { anchor: string; kind: string; summary_of_anchor: string | null }[];

      const foundAnchors = new Set(existing.map((r) => r.anchor));
      const missing = params.sourceAnchors.filter((a) => !foundAnchors.has(a));
      if (missing.length > 0) {
        throw new Error(`Source anchors not found: ${missing.join(', ')}`);
      }

      // Cascade guard: none of the sources can be summaries
      const cascadeHits = existing.filter((r) => r.summary_of_anchor != null);
      if (cascadeHits.length > 0) {
        throw new Error(
          `cascade compression prohibited: source(s) [${cascadeHits.map((r) => r.anchor).join(', ')}] are already summaries`,
        );
      }

      // Determine kind: use param override, or majority kind from sources, default 'lesson'
      const kind = params.kind ?? this.majorityKind(existing.map((r) => r.kind));

      // Generate summary anchor
      const summaryAnchor = `CS-${Date.now().toString(36)}`;
      const groupId = `sg-${Date.now().toString(36)}`;
      const now = new Date().toISOString();

      const tx = db.transaction(() => {
        // Insert summary doc
        db.prepare(`
          INSERT INTO evidence_docs
          (anchor, kind, status, title, summary, updated_at, authority, activation,
           source_ids, summary_of_anchor, compression_rationale)
          VALUES (?, ?, 'active', ?, ?, ?, 'validated', 'query', ?, ?, ?)
        `).run(
          summaryAnchor,
          kind,
          params.title,
          params.summary,
          now,
          JSON.stringify(params.sourceAnchors),
          groupId,
          params.rationale,
        );

        // Demote originals to backstop
        db.prepare(`UPDATE evidence_docs SET activation = 'backstop' WHERE anchor IN (${placeholders})`).run(
          ...params.sourceAnchors,
        );
      });

      tx();
      return summaryAnchor;
    });
  }

  /** Pick the most common kind from a list, defaulting to 'lesson' */
  private majorityKind(kinds: string[]): EvidenceItem['kind'] {
    const counts = new Map<string, number>();
    for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
    let best = 'lesson';
    let bestCount = 0;
    for (const [k, c] of counts) {
      if (c > bestCount) {
        best = k;
        bestCount = c;
      }
    }
    return best as EvidenceItem['kind'];
  }

  /**
   * F163 AC-A3: Query always_on + constitutional docs for physical injection.
   * Guard: activation=always_on AND authority=constitutional AND status=active.
   * Synchronous — used at prompt build time, not in search pipeline.
   */
  queryAlwaysOn(): Array<{ anchor: string; title: string; summary: string }> {
    this.ensureOpen();
    return (
      (this.db
        ?.prepare(
          `SELECT anchor, title, summary
         FROM evidence_docs
         WHERE activation = 'always_on'
           AND authority = 'constitutional'
           AND status = 'active'`,
        )
        .all() as Array<{ anchor: string; title: string; summary: string }>) ?? []
    );
  }

  // ── Edge operations ─────────────────────────────────────────────────

  async addEdge(edge: Edge): Promise<void> {
    return this.writeQueue.enqueue(() => {
      this.ensureOpen();
      this.db
        ?.prepare(
          `INSERT OR IGNORE INTO edges
           (from_anchor, to_anchor, relation, from_collection_id, to_collection_id, edge_sensitivity, provenance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          edge.fromAnchor,
          edge.toAnchor,
          edge.relation,
          edge.fromCollectionId ?? null,
          edge.toCollectionId ?? null,
          edge.edgeSensitivity ?? null,
          edge.provenance ?? null,
          edge.createdAt ?? new Date().toISOString(),
        );
    });
  }

  async getRelated(anchor: string): Promise<
    Array<{
      anchor: string;
      relation: string;
      fromCollectionId: string | null;
      toCollectionId: string | null;
      edgeSensitivity: string | null;
      provenance: string | null;
      traversalCount: number;
      lastTraversedAt: string | null;
    }>
  > {
    this.ensureOpen();
    const rows = this.db
      ?.prepare(
        `SELECT to_anchor AS anchor,
                CASE WHEN relation = 'related' THEN 'related_to' ELSE relation END AS relation,
                from_collection_id AS fromCollectionId,
                to_collection_id AS toCollectionId,
                edge_sensitivity AS edgeSensitivity,
                provenance,
                COALESCE(traversal_count, 0) AS traversalCount,
                last_traversed_at AS lastTraversedAt
         FROM edges WHERE from_anchor = ?
         UNION
         SELECT from_anchor AS anchor,
                CASE WHEN relation = 'related' THEN 'related_to' ELSE relation END AS relation,
                from_collection_id AS fromCollectionId,
                to_collection_id AS toCollectionId,
                edge_sensitivity AS edgeSensitivity,
                provenance,
                COALESCE(traversal_count, 0) AS traversalCount,
                last_traversed_at AS lastTraversedAt
         FROM edges WHERE to_anchor = ?`,
      )
      .all(anchor, anchor) as Array<{
      anchor: string;
      relation: string;
      fromCollectionId: string | null;
      toCollectionId: string | null;
      edgeSensitivity: string | null;
      provenance: string | null;
      traversalCount: number;
      lastTraversedAt: string | null;
    }>;
    return rows;
  }

  async removeEdge(edge: Edge): Promise<void> {
    return this.writeQueue.enqueue(() => {
      this.ensureOpen();
      this.db
        ?.prepare('DELETE FROM edges WHERE from_anchor = ? AND to_anchor = ? AND relation = ?')
        .run(edge.fromAnchor, edge.toAnchor, edge.relation);
    });
  }

  // ── Passage operations ─────────────────────────────────────────────

  /** Search passage_fts and return matching passages with doc context. */
  searchPassages(
    query: string,
    limit = 10,
    timeFilter?: { dateFrom?: string; dateTo?: string },
    options?: { contextWindow?: number },
  ): PassageResult[] {
    this.ensureOpen();
    const trimmed = query.trim();
    if (!trimmed) return [];

    const ftsQuery = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(' ');

    if (!ftsQuery) return [];

    try {
      let sql = `SELECT p.doc_anchor, p.passage_id, p.content, p.speaker, p.position, p.created_at,
                  bm25(passage_fts) AS rank
           FROM passage_fts f
           JOIN evidence_passages p ON p.rowid = f.rowid
           WHERE passage_fts MATCH ?`;
      const params: unknown[] = [ftsQuery];

      if (timeFilter?.dateFrom) {
        sql += ' AND p.created_at >= ?';
        params.push(timeFilter.dateFrom);
      }
      if (timeFilter?.dateTo) {
        // Add 'T23:59:59' to make dateTo inclusive for the full day
        sql += ' AND p.created_at <= ?';
        params.push(timeFilter.dateTo.length === 10 ? `${timeFilter.dateTo}T23:59:59` : timeFilter.dateTo);
      }

      sql += ' ORDER BY rank LIMIT ?';
      params.push(limit);

      const rows = this.db?.prepare(sql).all(...params) as Array<{
        doc_anchor: string;
        passage_id: string;
        content: string;
        speaker: string | null;
        position: number | null;
        created_at: string | null;
        rank: number;
      }>;

      const results: PassageResult[] = (rows ?? []).map((r) => ({
        docAnchor: r.doc_anchor,
        passageId: r.passage_id,
        content: r.content,
        speaker: r.speaker ?? undefined,
        position: r.position ?? undefined,
        rank: r.rank,
        createdAt: r.created_at ?? undefined,
      }));

      // AC-I8: fetch surrounding passages within the context window
      const cw = options?.contextWindow;
      if (cw && cw > 0 && this.db) {
        const ctxStmt = this.db.prepare(
          `SELECT doc_anchor, passage_id, content, speaker, position, created_at
           FROM evidence_passages
           WHERE doc_anchor = ? AND position BETWEEN ? AND ? AND passage_id != ?
           ORDER BY position`,
        );
        for (const r of results) {
          if (r.position != null) {
            const ctxRows = ctxStmt.all(r.docAnchor, r.position - cw, r.position + cw, r.passageId) as Array<{
              doc_anchor: string;
              passage_id: string;
              content: string;
              speaker: string | null;
              position: number | null;
              created_at: string | null;
            }>;
            r.context = ctxRows.map((c) => ({
              docAnchor: c.doc_anchor,
              passageId: c.passage_id,
              content: c.content,
              speaker: c.speaker ?? undefined,
              position: c.position ?? undefined,
              createdAt: c.created_at ?? undefined,
            }));
          }
        }
      }

      return results;
    } catch {
      // FTS5 syntax error — degrade gracefully
      return [];
    }
  }

  close(): void {
    if (this.db?.open) {
      this.db.close();
    }
    this.db = null;
  }

  private ensureOpen(): void {
    if (!this.db || !this.db.open) {
      throw new Error('SqliteEvidenceStore not initialized — call initialize() first');
    }
  }
}

function mergeEntityMatchMaps(
  left: Map<string, EntityMatch[]>,
  right?: Map<string, EntityMatch[]>,
): Map<string, EntityMatch[]> {
  if (!right || right.size === 0) return left;
  const merged = new Map<string, EntityMatch[]>();
  for (const [anchor, matches] of left) merged.set(anchor, [...matches]);
  for (const [anchor, matches] of right) {
    const arr = merged.get(anchor) ?? [];
    arr.push(...matches);
    merged.set(anchor, arr);
  }
  return merged;
}

function mergePassageResults(entityPassages: PassageResult[], passages: PassageResult[]): PassageResult[] {
  if (entityPassages.length === 0) return passages;
  const out: PassageResult[] = [];
  const seen = new Set<string>();
  for (const passage of [...entityPassages, ...passages]) {
    const key = passageVectorKey(passage.docAnchor, passage.passageId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(passage);
  }
  return out;
}

function dedupeEntityMatches(matches: EntityMatch[]): EntityMatch[] {
  const seen = new Set<string>();
  const out: EntityMatch[] = [];
  for (const match of matches) {
    const key = `${match.entityId}\u0000${match.docAnchor}\u0000${match.passageId ?? ''}\u0000${match.surface}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
}

// ── Row mapping ──────────────────────────────────────────────────────

interface RowShape {
  anchor: string;
  kind: string;
  status: string;
  title: string;
  summary: string | null;
  keywords: string | null;
  source_path: string | null;
  source_hash: string | null;
  superseded_by: string | null;
  materialized_from: string | null;
  updated_at: string;
  pack_id: string | null;
  provenance_tier: string | null;
  provenance_source: string | null;
  generalizable: number | null;
  authority: string | null;
  activation: string | null;
  verified_at: string | null;
  source_ids: string | null;
  summary_of_anchor: string | null;
  compression_rationale: string | null;
  contradicts: string | null;
  invalid_at: string | null;
  review_cycle_days: number | null;
  world_id: string | null;
  scene_id: string | null;
  collection_id: string | null;
  review_status: string | null;
  first_indexed_at: number | null;
}

function rowToItem(row: RowShape): EvidenceItem {
  const item: EvidenceItem = {
    anchor: row.anchor,
    kind: row.kind as EvidenceItem['kind'],
    status: row.status as EvidenceItem['status'],
    title: row.title,
    updatedAt: row.updated_at,
  };
  if (row.summary != null) item.summary = row.summary;
  if (row.keywords != null) item.keywords = JSON.parse(row.keywords);
  if (row.source_path != null) item.sourcePath = row.source_path;
  if (row.source_hash != null) item.sourceHash = row.source_hash;
  if (row.superseded_by != null) item.supersededBy = row.superseded_by;
  if (row.materialized_from != null) item.materializedFrom = row.materialized_from;
  if (row.pack_id != null) item.packId = row.pack_id;
  if (row.provenance_tier != null) {
    item.provenance = {
      tier: row.provenance_tier as 'authoritative' | 'derived' | 'soft_clue',
      source: row.provenance_source ?? '',
    };
  }
  if (row.generalizable != null) item.generalizable = row.generalizable === 1;
  if (row.authority != null) item.authority = row.authority as EvidenceItem['authority'];
  if (row.activation != null) item.activation = row.activation as EvidenceItem['activation'];
  if (row.verified_at != null) item.verifiedAt = row.verified_at;
  if (row.source_ids != null) item.sourceIds = JSON.parse(row.source_ids);
  if (row.summary_of_anchor != null) item.summaryOfAnchor = row.summary_of_anchor;
  if (row.compression_rationale != null) item.compressionRationale = row.compression_rationale;
  if (row.contradicts != null) item.contradicts = JSON.parse(row.contradicts);
  if (row.invalid_at != null) item.invalidAt = row.invalid_at;
  if (row.review_cycle_days != null) item.reviewCycleDays = row.review_cycle_days;
  if (row.world_id != null) item.worldId = row.world_id;
  if (row.scene_id != null) item.sceneId = row.scene_id;
  if (row.review_status != null) item.reviewStatus = row.review_status as EvidenceItem['reviewStatus'];
  if (row.first_indexed_at != null) item.firstIndexedAt = row.first_indexed_at;
  return item;
}

// ── F163: Authority boost weights (1.0–1.3 range, spec constraint) ──

const AUTHORITY_WEIGHTS: Record<F163Authority, number> = {
  constitutional: 1.3,
  validated: 1.2,
  candidate: 1.1,
  observed: 1.0,
};

/**
 * F163: Post-retrieval authority boost. Reranks results in-place when
 * F163_AUTHORITY_BOOST is 'on'. In 'shadow' mode, the boost is computed
 * but the original order is preserved. In 'off' mode, this is a no-op.
 */
function applyAuthorityBoost(results: EvidenceItem[]): void {
  const flags = freezeFlags();
  if (flags.authorityBoost === 'off' || results.length < 2) return;

  // RRF-style positional score: 1/(rank+k) keeps adjacent positions close
  // so the 1.0–1.3 authority weight can meaningfully reorder near-tied items.
  const K = 60;
  const scored = results.map((item, i) => ({
    item,
    score: (1 / (i + K)) * AUTHORITY_WEIGHTS[(item.authority as F163Authority) ?? 'observed'],
  }));

  scored.sort((a, b) => b.score - a.score);

  if (flags.authorityBoost === 'on') {
    // Rewrite results array in-place
    for (let i = 0; i < results.length; i++) {
      results[i] = scored[i].item;
    }
  }
  // shadow: order unchanged, but boost was computed (logging in Task 7)
}

// ── F200 Phase C: Consumption-weighted rerank ──

interface AnchorMetricRow {
  anchor: string;
  consumed_count_30d: number;
  exposure_count_30d: number;
  dormancy_days: number | null;
}

function loadAnchorMetrics(db: Database.Database, anchors: string[]): Map<string, AnchorMetricRow> {
  if (anchors.length === 0) return new Map();
  const placeholders = anchors.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT * FROM anchor_recall_metrics WHERE anchor IN (${placeholders})`)
    .all(...anchors) as AnchorMetricRow[];
  return new Map(rows.map((r) => [r.anchor, r]));
}

function loadGlobalCtrBaseline(db: Database.Database): Record<string, number> {
  const rows = db.prepare('SELECT doc_kind, mean_ctr FROM global_ctr_baseline').all() as Array<{
    doc_kind: string;
    mean_ctr: number;
  }>;
  const result: Record<string, number> = {};
  for (const r of rows) result[r.doc_kind] = r.mean_ctr;
  return result;
}

const _shadowRankingMap = new Map<string, Array<Array<{ anchor: string; shadowRank: number }>>>();
const MAX_SHADOW_ENTRIES = 32;

function shadowKey(anchors: string[]): string {
  return anchors.slice(0, 8).join('|');
}

function storeShadowRanking(resultAnchors: string[], ranking: Array<{ anchor: string; shadowRank: number }>): void {
  const key = shadowKey(resultAnchors);
  const existing = _shadowRankingMap.get(key);
  if (existing) {
    existing.push(ranking);
  } else {
    if (_shadowRankingMap.size >= MAX_SHADOW_ENTRIES) {
      const oldest = _shadowRankingMap.keys().next().value;
      if (oldest != null) _shadowRankingMap.delete(oldest);
    }
    _shadowRankingMap.set(key, [ranking]);
  }
}

export function lookupShadowRanking(candidateAnchors: string[]): Array<{ anchor: string; shadowRank: number }> | null {
  const key = shadowKey(candidateAnchors);
  const stack = _shadowRankingMap.get(key);
  if (!stack || stack.length === 0) return null;
  const ranking = stack.shift()!;
  if (stack.length === 0) _shadowRankingMap.delete(key);
  return ranking;
}

export function applyConsumptionRerank(results: EvidenceItem[], db: Database.Database, targetLimit?: number): void {
  const f200Flags = freezeF200Flags();
  if (f200Flags.consumptionRerank === 'off' || results.length < 2) return;

  const anchorMetrics = loadAnchorMetrics(
    db,
    results.map((r) => r.anchor),
  );
  const globalMeanCtr = loadGlobalCtrBaseline(db);

  const K = 60;
  const BETA = 0.15;
  const GAMMA = 0.1;

  const scored = results.map((item, i) => {
    const metrics = anchorMetrics.get(item.anchor);
    const prior = computeConsumptionPrior(
      {
        consumedCount30d: metrics?.consumed_count_30d ?? 0,
        exposureCount30d: metrics?.exposure_count_30d ?? 0,
        daysSinceLastConsumed: metrics?.dormancy_days ?? null,
        docKind: item.kind ?? 'unknown',
        authority: (item.authority as F163Authority) ?? 'observed',
        firstIndexedAt: item.firstIndexedAt ?? 0,
      },
      globalMeanCtr,
    );

    const ageDays = item.updatedAt ? (Date.now() - new Date(item.updatedAt).getTime()) / 86_400_000 : 365;
    const decay = computeRecencyDecay(ageDays, item.kind ?? 'unknown');

    const positionalScore = 1 / (i + K);
    const newScore = positionalScore + BETA * prior.prior + GAMMA * (decay.factor - 0.5);

    const isConstitutional = prior.branch === 'constitutional';
    return { item, newScore, originalIndex: i, isConstitutional };
  });

  const pinned = new Map<number, EvidenceItem>();
  let movable: Array<{ item: EvidenceItem; newScore: number }> = [];
  for (const s of scored) {
    if (s.isConstitutional) pinned.set(s.originalIndex, s.item);
    else movable.push(s);
  }
  movable.sort((a, b) => b.newScore - a.newScore);

  if (targetLimit && movable.length >= 3 * targetLimit) {
    const mmrItems = movable.map((m) => ({ item: m.item, score: m.newScore }));
    const mmrResults = applyMMR(mmrItems, targetLimit, 0.7);
    movable = mmrResults.map((item, i) => ({ item, newScore: targetLimit - i }));
  }

  const final: EvidenceItem[] = [];
  let mi = 0;
  for (let i = 0; i < results.length; i++) {
    if (pinned.has(i)) {
      final.push(pinned.get(i)!);
    } else if (mi < movable.length) {
      final.push(movable[mi++].item);
    }
  }

  const shadowOrder: Array<{ anchor: string; shadowRank: number }> = final.map((item, i) => ({
    anchor: item.anchor,
    shadowRank: i,
  }));
  if (f200Flags.consumptionRerank === 'on') {
    for (let i = 0; i < final.length; i++) results[i] = final[i];
    results.length = final.length;
  }
  const keyAnchors =
    targetLimit != null && results.length > targetLimit
      ? results.slice(0, targetLimit).map((r) => r.anchor)
      : results.map((r) => r.anchor);
  storeShadowRanking(keyAnchors, shadowOrder);
}

function annotateMatchReasons(results: EvidenceItem[], query: string, explain?: boolean): void {
  if (!query) return;
  const q = query.toLowerCase();
  for (const item of results) {
    if (item.entityMatches?.length) {
      item.matchReason = `entity:${item.entityMatches[0].entityId}`;
    } else if (item.anchor.toLowerCase().includes(q)) {
      item.matchReason = 'anchor';
    } else if (item.title.toLowerCase().includes(q)) {
      item.matchReason = 'title';
    } else if (item.summary?.toLowerCase().includes(q)) {
      item.matchReason = 'summary';
    } else if (item.keywords?.some((k) => k.toLowerCase().includes(q))) {
      item.matchReason = 'keyword';
    } else {
      item.matchReason = 'content';
    }
    if (explain) {
      item.rankingFactors = { bm25Score: results.indexOf(item) + 1 };
    }
  }
}
