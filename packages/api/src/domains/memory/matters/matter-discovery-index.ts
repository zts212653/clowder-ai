import type Database from 'better-sqlite3';
import type { MatterCatalogKey } from './matter-catalog-cursor.js';

/** External-content FTS stores tokens, never a second description or page authority. */
export const MATTER_DISCOVERY_SCHEMA = `
CREATE INDEX IF NOT EXISTS idx_memory_matters_discovery ON memory_matters(owner_user_id, updated_at DESC, matter_id);
CREATE INDEX IF NOT EXISTS idx_memory_matter_thread ON memory_matter_entries(matter_id, status, json_extract(source_json, '$.threadId'));
CREATE VIEW IF NOT EXISTS memory_matter_source_text AS
  SELECT rowid, title || char(10) || description AS text FROM memory_matters;
CREATE VIRTUAL TABLE IF NOT EXISTS memory_matter_search USING fts5(
  text, content=memory_matter_source_text, content_rowid=rowid, tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS memory_matter_search_insert AFTER INSERT ON memory_matters BEGIN
  INSERT INTO memory_matter_search(rowid,text) VALUES(new.rowid, new.title || char(10) || new.description);
END;
CREATE TRIGGER IF NOT EXISTS memory_matter_search_delete AFTER DELETE ON memory_matters BEGIN
  INSERT INTO memory_matter_search(memory_matter_search,rowid,text) VALUES('delete', old.rowid, old.title || char(10) || old.description);
END;
CREATE TRIGGER IF NOT EXISTS memory_matter_search_update AFTER UPDATE OF title, description ON memory_matters BEGIN
  INSERT INTO memory_matter_search(memory_matter_search,rowid,text) VALUES('delete', old.rowid, old.title || char(10) || old.description);
  INSERT INTO memory_matter_search(rowid,text) VALUES(new.rowid, new.title || char(10) || new.description);
END;
INSERT INTO memory_matter_search(memory_matter_search) VALUES('rebuild');
`;

export interface MatterDiscoveryRow {
  matterId: string;
  revision: number;
  status: 'active' | 'retired';
  updatedAt: number;
}

export class MatterDiscoveryIndex {
  constructor(private readonly db: Database.Database) {
    // Literal matching is the existing directory contract, including Unicode case folding.
    db.function('matter_query_matches', { deterministic: true }, (title, description, query) =>
      `${title}\n${description}`.toLocaleLowerCase().includes(String(query).toLocaleLowerCase()) ? 1 : 0,
    );
  }

  current(ownerUserId: string, row: MatterDiscoveryRow): boolean {
    return Boolean(
      this.db
        .prepare(`SELECT 1 FROM memory_matters WHERE owner_user_id = ? AND matter_id = ?
      AND revision = ? AND updated_at = ? AND status = ?`)
        .get(ownerUserId, row.matterId, row.revision, row.updatedAt, row.status),
    );
  }

  candidates(
    ownerUserId: string,
    options: {
      query?: string;
      threadId?: string;
      management: boolean;
      relatedOnly: boolean;
      after: MatterCatalogKey | null;
      offset: number;
      limit: number;
    },
  ): MatterDiscoveryRow[] {
    const clauses = ['owner_user_id = @owner'];
    const params: Record<string, string | number> = {
      owner: ownerUserId,
      offset: options.offset,
      limit: options.limit,
    };
    if (!options.management) clauses.push("status = 'active'");
    if (options.relatedOnly) {
      clauses.push(`EXISTS (SELECT 1 FROM memory_matter_entries e WHERE e.matter_id = m.matter_id
        AND e.status = 'active' AND json_extract(e.source_json,'$.threadId') = @thread)`);
      params.thread = options.threadId!;
    }
    if (options.query) {
      params.query = options.query;
      // Trigrams cannot index one/two-character queries; the ordered owner index still bounds reads.
      if ([...options.query].length >= 3) {
        clauses.push('m.rowid IN (SELECT rowid FROM memory_matter_search WHERE text MATCH @match)');
        params.match = `"${options.query.replace(/"/g, '""')}"`;
      }
      clauses.push('matter_query_matches(title, description, @query)');
    }
    if (options.after && options.after.related === options.relatedOnly) {
      clauses.push('(updated_at < @time OR (updated_at = @time AND matter_id > @id))');
      params.time = options.after.updatedAt;
      params.id = options.after.matterId;
    }
    return this.db
      .prepare(`SELECT matter_id AS matterId, revision, status, updated_at AS updatedAt
      FROM memory_matters m WHERE ${clauses.join(' AND ')} ORDER BY updated_at DESC, matter_id LIMIT @limit OFFSET @offset`)
      .all(params) as MatterDiscoveryRow[];
  }
}
