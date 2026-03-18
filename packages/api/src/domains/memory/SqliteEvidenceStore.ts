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
import { SemanticReranker } from './SemanticReranker.js';
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
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Phase D: resolve scope → kind filter
    // scope='threads'/'sessions' → only search kind='session'
    // scope='docs'/'memory' → exclude sessions (feature/decision/plan/lesson + future memory entries)
    // scope='all' → no filter
    const effectiveKind =
      options?.kind ??
      (options?.scope === 'threads' || options?.scope === 'sessions' ? ('session' as EvidenceKind) : undefined);
    const excludeSession = options?.scope === 'docs' || options?.scope === 'memory';
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
        params.push(limit);

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
        if (options?.status) {
          kwSql += ' AND status = ?';
          kwParams.push(options.status);
        }
        if (options?.keywords?.length) {
          kwSql += ` AND (${options.keywords.map(() => 'keywords LIKE ?').join(' OR ')})`;
          kwParams.push(...options.keywords.map((kw) => `%"${kw}"%`));
        }
        kwSql += " ORDER BY (superseded_by IS NOT NULL), (source_path LIKE 'archive/%'), updated_at DESC LIMIT ?";
        kwParams.push(limit);
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

    let lexicalResults = results.slice(0, limit);

    // Phase C: semantic rerank
    if (this.embedDeps && this.embedDeps.embedding.isReady()) {
      try {
        const queryVec = await this.embedDeps.embedding.embed([query]);
        const vecResults = this.embedDeps.vectorStore.search(queryVec[0], limit * 2);
        const reranker = new SemanticReranker();

        if (this.embedDeps.mode === 'on') {
          lexicalResults = reranker.rerankWithDistances(lexicalResults, vecResults);
        } else if (this.embedDeps.mode === 'shadow') {
          // Shadow: compute rerank but return lexical order (log comparison)
          const _reranked = reranker.rerankWithDistances(lexicalResults, vecResults);
          // Silent comparison — actual logging added in eval phase
        }
      } catch {
        // AC-C4 fail-open: rerank failed → return lexical order
      }
    }

    return lexicalResults;
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
				 superseded_by, materialized_from, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        );
      }
    });

    tx(items);
  }

  async deleteByAnchor(anchor: string): Promise<void> {
    this.ensureOpen();
    this.db?.prepare('DELETE FROM evidence_docs WHERE anchor = ?').run(anchor);
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
  return item;
}
