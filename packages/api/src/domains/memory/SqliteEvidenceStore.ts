// F102: SQLite implementation of IEvidenceStore

import Database from 'better-sqlite3';
import type {
  Edge,
  EvidenceItem,
  EvidenceKind,
  IEmbeddingService,
  IEvidenceStore,
  SearchOptions,
} from './interfaces.js';
import { applyMigrations } from './schema.js';
import type { VectorStore } from './VectorStore.js';

export interface PassageResult {
  docAnchor: string;
  passageId: string;
  content: string;
  speaker?: string;
  position?: number;
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

    // Phase D: resolve scope → kind filter
    // scope='threads' → kind='thread' (P1 fix: was incorrectly mapped to 'session')
    // scope='sessions' → kind='session'
    // scope='docs'/'memory' → exclude sessions + threads
    // scope='all' → no filter
    const effectiveKind =
      options?.kind ??
      (options?.scope === 'threads'
        ? ('thread' as EvidenceKind)
        : options?.scope === 'sessions'
          ? ('session' as EvidenceKind)
          : undefined);
    const excludeSession = options?.scope === 'docs' || options?.scope === 'memory';
    // F129 AC-A10: exclude pack-knowledge from global search unless explicitly requested
    const excludePackKnowledge = effectiveKind !== 'pack-knowledge';
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
    if (excludeSession) {
      anchorSql += " AND kind != 'session'";
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
        if (excludeSession) {
          sql += " AND d.kind != 'session'";
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

        // Superseded items sort last (KD-16), archive results deprioritized (P2 fix)
        sql += " ORDER BY (d.superseded_by IS NOT NULL), (d.source_path LIKE 'archive/%'), rank";
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

    // ── Keyword fallback: search keywords/topics JSON when FTS5 misses ──
    if (results.length <= 1) {
      const words = trimmed.split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        const kwConditions = words.map(() => 'keywords LIKE ?');
        let kwSql = `SELECT * FROM evidence_docs WHERE (${kwConditions.join(' OR ')})`;
        const kwParams: unknown[] = words.map((w) => `%${w.toLowerCase()}%`);
        if (effectiveKind) {
          kwSql += ' AND kind = ?';
          kwParams.push(effectiveKind);
        }
        if (excludeSession) {
          kwSql += " AND kind != 'session'";
        }
        if (excludePackKnowledge) {
          kwSql += " AND kind != 'pack-knowledge'";
        }
        if (options?.status) {
          kwSql += ' AND status = ?';
          kwParams.push(options.status);
        }
        if (options?.keywords?.length) {
          kwSql += ` AND (${options.keywords.map(() => 'keywords LIKE ?').join(' OR ')})`;
          kwParams.push(...options.keywords.map((kw) => `%"${kw}"%`));
        }
        kwSql += " ORDER BY (superseded_by IS NOT NULL), (source_path LIKE 'archive/%'), updated_at DESC LIMIT ?";
        kwParams.push(bm25Pool);
        try {
          const kwRows = this.db?.prepare(kwSql).all(...kwParams) as RowShape[];
          for (const row of kwRows) {
            if (!seenAnchors.has(row.anchor)) {
              results.push(rowToItem(row));
              seenAnchors.add(row.anchor);
            }
          }
        } catch {
          // keyword search failed — continue with existing results
        }
      }
    }

    // Phase E: passage search when depth=raw and scope includes threads
    if (options?.depth === 'raw' && (!options?.scope || options.scope === 'all' || options.scope === 'threads')) {
      const passages = this.searchPassages(trimmed, limit);
      for (const p of passages) {
        if (!seenAnchors.has(p.docAnchor)) {
          // Synthesize an EvidenceItem from the passage's parent doc anchor
          const parentDoc = this.db?.prepare('SELECT * FROM evidence_docs WHERE anchor = ?').get(p.docAnchor) as
            | RowShape
            | undefined;
          if (parentDoc) {
            const item = rowToItem(parentDoc);
            // Enrich summary with passage match context
            item.summary = `[passage match] ${p.speaker ? `${p.speaker}: ` : ''}${p.content.slice(0, 200)}`;
            results.push(item);
            seenAnchors.add(p.docAnchor);
          }
        }
      }
    }

    // P1 fix (砚砚 review): depth=raw must stay lexical-only — no passage vectors yet.
    // Short-circuit BEFORE mode split to prevent semantic/hybrid from eating raw results.
    if (options?.depth === 'raw') {
      return this.enrichWithDrillDown(results.slice(0, limit));
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
        return this.enrichWithDrillDown(await this.semanticNNSearch(query, limit, options));
      } catch {
        return this.enrichWithDrillDown(lexicalResults);
      }
    }

    if (searchMode === 'hybrid') {
      if (!embeddingAvailable) {
        return this.enrichWithDrillDown(lexicalResults);
      }
      try {
        return this.enrichWithDrillDown(await this.hybridRRFSearch(query, lexicalCandidates, limit, options));
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
  private async semanticNNSearch(query: string, limit: number, options?: SearchOptions): Promise<EvidenceItem[]> {
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
    const excludeSession = options?.scope === 'docs' || options?.scope === 'memory';
    const excludePackKnowledge = effectiveKind !== 'pack-knowledge';
    if (effectiveKind) {
      sql += ' AND kind = ?';
      params.push(effectiveKind);
    }
    if (excludeSession) {
      sql += " AND kind != 'session'";
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
      const excludeSession = options?.scope === 'docs' || options?.scope === 'memory';
      const excludePackKnowledge = effectiveKind !== 'pack-knowledge';
      if (effectiveKind) {
        sql += ' AND kind = ?';
        params.push(effectiveKind);
      }
      if (excludeSession) {
        sql += " AND kind != 'session'";
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
    this.ensureOpen();
    const db = this.db;
    if (!db) {
      throw new Error('Evidence store is closed');
    }

    const stmt = db.prepare(`
				INSERT OR REPLACE INTO evidence_docs
				(anchor, kind, status, title, summary, keywords, source_path, source_hash,
				 superseded_by, materialized_from, updated_at, pack_id)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        );
      }
    });

    tx(items);
  }

  async deleteByAnchor(anchor: string): Promise<void> {
    this.ensureOpen();
    this.db?.prepare('DELETE FROM evidence_docs WHERE anchor = ?').run(anchor);
  }

  /** F129: Delete all evidence entries for a given pack_id */
  async deleteByPackId(packId: string): Promise<number> {
    this.ensureOpen();
    const result = this.db?.prepare('DELETE FROM evidence_docs WHERE pack_id = ?').run(packId);
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

  // ── Edge operations ─────────────────────────────────────────────────

  async addEdge(edge: Edge): Promise<void> {
    this.ensureOpen();
    this.db
      ?.prepare('INSERT OR IGNORE INTO edges (from_anchor, to_anchor, relation) VALUES (?, ?, ?)')
      .run(edge.fromAnchor, edge.toAnchor, edge.relation);
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
    this.ensureOpen();
    this.db
      ?.prepare('DELETE FROM edges WHERE from_anchor = ? AND to_anchor = ? AND relation = ?')
      .run(edge.fromAnchor, edge.toAnchor, edge.relation);
  }

  // ── Passage operations ─────────────────────────────────────────────

  /** Search passage_fts and return matching passages with doc context. */
  searchPassages(query: string, limit = 10): PassageResult[] {
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
      const rows = this.db
        ?.prepare(
          `SELECT p.doc_anchor, p.passage_id, p.content, p.speaker, p.position,
                  bm25(passage_fts) AS rank
           FROM passage_fts f
           JOIN evidence_passages p ON p.rowid = f.rowid
           WHERE passage_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{
        doc_anchor: string;
        passage_id: string;
        content: string;
        speaker: string | null;
        position: number | null;
        rank: number;
      }>;

      return (rows ?? []).map((r) => ({
        docAnchor: r.doc_anchor,
        passageId: r.passage_id,
        content: r.content,
        speaker: r.speaker ?? undefined,
        position: r.position ?? undefined,
      }));
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
  return item;
}
