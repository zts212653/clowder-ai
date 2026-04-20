// F102: SQLite implementation of IEvidenceStore

import Database from 'better-sqlite3';
import { EvidenceWriteQueue } from './evidence-write-queue.js';
import { ContradictionDetector } from './f163-contradiction-detector.js';
import { type F163Authority, freezeFlags, pathToAuthority } from './f163-types.js';
import type {
  Edge,
  EvidenceItem,
  EvidenceKind,
  IEmbeddingService,
  IEvidenceStore,
  SearchOptions,
} from './interfaces.js';
import {
  compareEvidenceItemsByLexicalBackfill,
  rankLexicalBackfillRows,
  splitLexicalBackfillWords,
} from './lexical-backfill.js';
import { applyMigrations } from './schema.js';
import type { VectorStore } from './VectorStore.js';

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
  mode: 'off' | 'shadow' | 'on';
}

export class SqliteEvidenceStore implements IEvidenceStore {
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private embedDeps?: EmbedDeps;
  /** F163: single-writer queue serializes all evidence.sqlite mutations */
  private readonly writeQueue = new EvidenceWriteQueue();

  constructor(dbPath: string, embedDeps?: EmbedDeps) {
    this.dbPath = dbPath;
    this.embedDeps = embedDeps;
  }

  /** @internal Allow late-binding of embed deps (factory sets after construction) */
  setEmbedDeps(deps: EmbedDeps): void {
    this.embedDeps = deps;
  }

  async initialize(): Promise<void> {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    applyMigrations(this.db);
  }

  async search(query: string, options?: SearchOptions): Promise<EvidenceItem[]> {
    this.ensureOpen();
    const limit = options?.limit ?? 10;
    // P2 fix (砚砚): hybrid needs a wider BM25 candidate pool for meaningful RRF
    const bm25Pool = options?.mode === 'hybrid' ? Math.min(Math.max(limit * 4, 20), 100) : limit;
    const trimmed = query.trim();
    if (!trimmed) return [];
    const lexicalBackfillWords = splitLexicalBackfillWords(trimmed);

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

    // Phase E + AC-I9: passage search when depth=raw and scope includes threads
    if (options?.depth === 'raw' && (!options?.scope || options.scope === 'all' || options.scope === 'threads')) {
      const cw = options?.contextWindow;
      const passages = this.searchPassages(
        trimmed,
        limit,
        { dateFrom: options?.dateFrom, dateTo: options?.dateTo },
        cw && cw > 0 ? { contextWindow: cw } : undefined,
      );
      // Group passages by docAnchor for structured return
      // P1-2 fix: when threadId filter is active, skip passages from other threads
      const passagesByAnchor = new Map<string, typeof passages>();
      for (const p of passages) {
        if (threadAnchor && p.docAnchor !== threadAnchor) continue;
        const arr = passagesByAnchor.get(p.docAnchor) ?? [];
        arr.push(p);
        passagesByAnchor.set(p.docAnchor, arr);
      }
      for (const [anchor, pList] of passagesByAnchor) {
        // Find existing result or synthesize from parent doc
        let item = results.find((r) => r.anchor === anchor);
        if (!item) {
          const parentDoc = this.db?.prepare('SELECT * FROM evidence_docs WHERE anchor = ?').get(anchor) as
            | RowShape
            | undefined;
          if (parentDoc) {
            item = rowToItem(parentDoc);
            item.summary = `[passage match] ${pList[0].speaker ? `${pList[0].speaker}: ` : ''}${pList[0].content.slice(0, 200)}`;
            results.push(item);
            seenAnchors.add(anchor);
          }
        }
        if (item) {
          item.passages = pList.map((p) => ({
            passageId: p.passageId,
            content: p.content,
            speaker: p.speaker,
            createdAt: p.createdAt,
            ...(p.context
              ? {
                  context: p.context.map((c) => ({
                    passageId: c.passageId,
                    content: c.content,
                    speaker: c.speaker,
                    createdAt: c.createdAt,
                  })),
                }
              : {}),
          }));
        }
      }
    }

    // P1 fix (砚砚 review): depth=raw must stay lexical-only — no passage vectors yet.
    // Short-circuit BEFORE mode split to prevent semantic/hybrid from eating raw results.
    if (options?.depth === 'raw') {
      // Passage ranking fix: results with passage matches must rank before
      // doc-only hits so low-limit queries surface message-level content.
      results.sort((a, b) => {
        const aHas = a.passages?.length ? 1 : 0;
        const bHas = b.passages?.length ? 1 : 0;
        return bHas - aHas; // passage-bearing first, stable within each group
      });
      return this.enrichWithDrillDown(results.slice(0, limit));
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
    const embeddingAvailable = this.embedDeps?.embedding.isReady() && this.embedDeps.mode === 'on';

    // G-4: all paths go through enrichWithDrillDown before returning
    if (searchMode === 'lexical') {
      return this.enrichWithDrillDown(lexicalResults);
    }

    if (searchMode === 'semantic') {
      if (!embeddingAvailable) {
        return this.enrichWithDrillDown(lexicalResults);
      }
      try {
        return this.enrichWithDrillDown(await this.semanticNNSearch(query, limit, options, suppressBackstop));
      } catch {
        return this.enrichWithDrillDown(lexicalResults);
      }
    }

    if (searchMode === 'hybrid') {
      if (!embeddingAvailable) {
        return this.enrichWithDrillDown(lexicalResults);
      }
      try {
        return this.enrichWithDrillDown(
          await this.hybridRRFSearch(query, lexicalCandidates, limit, options, suppressBackstop),
        );
      } catch {
        return this.enrichWithDrillDown(lexicalResults);
      }
    }

    return this.enrichWithDrillDown(lexicalResults);
  }

  /**
   * G-4: Enrich search results with drill-down hints for thread/session items.
   * Tells the cat what MCP tool to use to see full details.
   */
  private enrichWithDrillDown(results: EvidenceItem[]): EvidenceItem[] {
    for (const item of results) {
      if (item.kind === 'thread' && item.anchor.startsWith('thread-')) {
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
      }
    }
    return results;
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

    // BM25 ranks
    for (let i = 0; i < lexicalResults.length; i++) {
      const anchor = lexicalResults[i].anchor;
      scores.set(anchor, (scores.get(anchor) ?? 0) + 1 / (RRF_K + i));
    }

    // NN ranks
    for (let i = 0; i < nnResults.length; i++) {
      const anchor = nnResults[i].anchor;
      scores.set(anchor, (scores.get(anchor) ?? 0) + 1 / (RRF_K + i));
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
				 contradicts, invalid_at, review_cycle_days)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`);

      const tx = db.transaction((items: EvidenceItem[]) => {
        for (const item of items) {
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
          );
        }
      });

      tx(items);
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
        ?.prepare('INSERT OR IGNORE INTO edges (from_anchor, to_anchor, relation) VALUES (?, ?, ?)')
        .run(edge.fromAnchor, edge.toAnchor, edge.relation);
    });
  }

  async getRelated(anchor: string): Promise<Array<{ anchor: string; relation: string }>> {
    this.ensureOpen();
    const rows = this.db
      ?.prepare(
        `SELECT to_anchor AS anchor, relation FROM edges WHERE from_anchor = ?
			 UNION
			 SELECT from_anchor AS anchor, relation FROM edges WHERE to_anchor = ?`,
      )
      .all(anchor, anchor) as Array<{ anchor: string; relation: string }>;
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
