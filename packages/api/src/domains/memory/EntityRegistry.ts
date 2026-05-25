// F209 Phase B: deterministic entity registry / alias dictionary.

import type Database from 'better-sqlite3';
import type {
  EntityMatch,
  EntityProvenance,
  EntityRecord,
  EntityType,
  EvidenceKind,
  EvidenceStatus,
  ProvenanceTier,
  QueryEntityMatch,
} from './interfaces.js';

interface EntityRow {
  entity_id: string;
  entity_type: string;
  canonical_name: string;
  provenance_json: string;
  created_at: string;
  updated_at: string;
}

interface AliasRow extends EntityRow {
  alias: string;
  alias_norm: string;
}

interface MentionRow extends EntityRow {
  surface: string;
  source: 'doc' | 'passage';
  doc_anchor: string;
  passage_id: string;
}

interface CompiledAliasRow extends AliasRow {
  matchesNormalizedText: (textNorm: string) => boolean;
}

export interface EntityMentionDocFilters {
  kind?: EvidenceKind;
  excludeSessionAndThread?: boolean;
  excludePackKnowledge?: boolean;
  status?: EvidenceStatus;
  keywords?: string[];
  anchor?: string;
  dateFrom?: string;
  dateTo?: string;
  worldId?: string;
  sceneId?: string;
  provenanceTier?: ProvenanceTier;
  suppressBackstop?: boolean;
}

export interface EntityMentionPassageHit {
  docAnchor: string;
  passageId: string;
  content: string;
  speaker?: string;
  position?: number;
  createdAt?: string;
}

export function normalizeEntityAlias(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function aliasMatchesText(text: string, alias: string): boolean {
  const aliasNorm = normalizeEntityAlias(alias);
  const textNorm = normalizeEntityAlias(text);
  const matcher = compileAliasMatcher(aliasNorm);
  return Boolean(textNorm && matcher?.(textNorm));
}

export class EntityRegistryStore {
  constructor(private readonly db: Database.Database) {}

  upsert(entities: EntityRecord[]): boolean {
    const entityStmt = this.db.prepare(`
      INSERT INTO entity_registry
      (entity_id, entity_type, canonical_name, provenance_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_id) DO UPDATE SET
        entity_type = excluded.entity_type,
        canonical_name = excluded.canonical_name,
        provenance_json = excluded.provenance_json,
        updated_at = excluded.updated_at
    `);
    const existingEntityStmt = this.db.prepare('SELECT * FROM entity_registry WHERE entity_id = ?');
    const existingAliasesStmt = this.db.prepare(
      'SELECT alias, alias_norm FROM entity_aliases WHERE entity_id = ? ORDER BY alias_norm, alias',
    );
    const deleteAliasesStmt = this.db.prepare('DELETE FROM entity_aliases WHERE entity_id = ?');
    const aliasStmt = this.db.prepare(`
      INSERT OR REPLACE INTO entity_aliases
      (entity_id, alias, alias_norm, provenance_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((records: EntityRecord[]) => {
      let changed = false;
      for (const entity of records) {
        const existing = existingEntityStmt.get(entity.entityId) as EntityRow | undefined;
        const aliases = uniqueAliases(entity.aliases);
        const createdAt = existing?.created_at ?? entity.createdAt ?? entity.updatedAt;
        const provenanceJson = JSON.stringify(entity.provenance);
        const existingAliases = existingAliasesStmt.all(entity.entityId) as Array<{
          alias: string;
          alias_norm: string;
        }>;
        if (entitySeedUnchanged(existing, existingAliases, entity, aliases, provenanceJson)) continue;

        changed = true;
        entityStmt.run(entity.entityId, entity.type, entity.canonicalName, provenanceJson, createdAt, entity.updatedAt);
        deleteAliasesStmt.run(entity.entityId);
        for (const alias of aliases) {
          aliasStmt.run(
            entity.entityId,
            alias,
            normalizeEntityAlias(alias),
            provenanceJson,
            createdAt,
            entity.updatedAt,
          );
        }
      }
      return changed;
    });
    return tx(entities) as boolean;
  }

  get(entityId: string): EntityRecord | null {
    const row = this.db.prepare('SELECT * FROM entity_registry WHERE entity_id = ?').get(entityId) as
      | EntityRow
      | undefined;
    if (!row) return null;
    const aliasRows = this.db
      .prepare('SELECT alias FROM entity_aliases WHERE entity_id = ? ORDER BY alias')
      .all(entityId) as Array<{ alias: string }>;
    return {
      entityId: row.entity_id,
      type: row.entity_type as EntityType,
      canonicalName: row.canonical_name,
      aliases: aliasRows.map((a) => a.alias),
      provenance: parseProvenance(row.provenance_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  resolveQuery(query: string): QueryEntityMatch[] {
    const rows = this.loadAliases({ includeCanonical: true });
    const matches: QueryEntityMatch[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.entity_id)) continue;
      if (!aliasMatchesText(query, row.alias)) continue;
      seen.add(row.entity_id);
      matches.push({
        entityId: row.entity_id,
        type: row.entity_type as EntityType,
        canonicalName: row.canonical_name,
        matchedAlias: row.alias,
        provenance: parseProvenance(row.provenance_json),
      });
    }
    return matches;
  }

  refreshMentions(docAnchors?: string[]): void {
    const aliases = compileAliases(this.loadAliases({ includeCanonical: true }));
    this.deleteMentions(docAnchors);
    if (aliases.length === 0) return;

    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO entity_mentions
      (entity_id, doc_anchor, passage_id, surface, surface_norm, source, provenance_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const docRows = this.selectDocs(docAnchors);
    const passageRows = this.selectPassages(docAnchors);
    const tx = this.db.transaction(() => {
      for (const doc of docRows) {
        const textNorm = normalizeEntityAlias([doc.title, doc.summary ?? '', doc.keywords ?? ''].join('\n'));
        for (const alias of aliases) {
          if (!alias.matchesNormalizedText(textNorm)) continue;
          insertStmt.run(
            alias.entity_id,
            doc.anchor,
            '',
            alias.alias,
            alias.alias_norm,
            'doc',
            alias.provenance_json,
            doc.updated_at,
          );
        }
      }
      for (const passage of passageRows) {
        const textNorm = normalizeEntityAlias(passage.content);
        for (const alias of aliases) {
          if (!alias.matchesNormalizedText(textNorm)) continue;
          insertStmt.run(
            alias.entity_id,
            passage.doc_anchor,
            passage.passage_id,
            alias.alias,
            alias.alias_norm,
            'passage',
            alias.provenance_json,
            passage.created_at,
          );
        }
      }
    });
    tx();
  }

  findMentionAnchors(
    queryMatches: QueryEntityMatch[],
    limit: number,
    filters?: EntityMentionDocFilters,
  ): {
    anchors: string[];
    matchesByAnchor: Map<string, EntityMatch[]>;
  } {
    if (queryMatches.length === 0) return { anchors: [], matchesByAnchor: new Map() };
    const anchors = this.selectMentionAnchors(queryMatches, limit, filters);
    const rows = this.selectMentionRowsForAnchors(queryMatches, anchors);
    const queryByEntity = new Map(queryMatches.map((m) => [m.entityId, m]));
    const matchesByAnchor = new Map<string, EntityMatch[]>();
    for (const row of rows) {
      const queryMatch = queryByEntity.get(row.entity_id);
      if (!queryMatch) continue;
      const arr = matchesByAnchor.get(row.doc_anchor) ?? [];
      arr.push(toEntityMatch(row, queryMatch));
      matchesByAnchor.set(row.doc_anchor, arr);
    }
    return { anchors, matchesByAnchor };
  }

  findMentionPassages(
    queryMatches: QueryEntityMatch[],
    limit: number,
    options?: { threadId?: string; dateFrom?: string; dateTo?: string },
  ): {
    passages: EntityMentionPassageHit[];
    matchesByAnchor: Map<string, EntityMatch[]>;
  } {
    if (queryMatches.length === 0) return { passages: [], matchesByAnchor: new Map() };
    const passageKeys = this.selectMentionPassageKeys(queryMatches, limit, options);
    const rows = this.selectMentionRowsForPassages(queryMatches, passageKeys);
    const passageOrder = new Map(
      passageKeys.map((passage, index) => [`${passage.doc_anchor}\u0000${passage.passage_id}`, index]),
    );
    rows.sort((a, b) => {
      const left = passageOrder.get(`${a.doc_anchor}\u0000${a.passage_id}`) ?? 0;
      const right = passageOrder.get(`${b.doc_anchor}\u0000${b.passage_id}`) ?? 0;
      return left - right;
    });
    const queryByEntity = new Map(queryMatches.map((m) => [m.entityId, m]));
    const passages: EntityMentionPassageHit[] = [];
    const matchesByAnchor = new Map<string, EntityMatch[]>();
    const seenPassages = new Set<string>();
    for (const row of rows) {
      const queryMatch = queryByEntity.get(row.entity_id);
      if (!queryMatch) continue;
      const key = `${row.doc_anchor}\u0000${row.passage_id}`;
      if (!seenPassages.has(key)) {
        seenPassages.add(key);
        passages.push({
          docAnchor: row.doc_anchor,
          passageId: row.passage_id,
          content: row.content,
          speaker: row.speaker ?? undefined,
          position: row.position ?? undefined,
          createdAt: row.created_at ?? undefined,
        });
      }
      const arr = matchesByAnchor.get(row.doc_anchor) ?? [];
      arr.push(toEntityMatch(row, queryMatch));
      matchesByAnchor.set(row.doc_anchor, arr);
    }
    return { passages, matchesByAnchor };
  }

  private loadAliases(options: { includeCanonical?: boolean } = {}): AliasRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.*, a.alias, a.alias_norm, a.provenance_json
         FROM entity_aliases a
         JOIN entity_registry r ON r.entity_id = a.entity_id
         ORDER BY length(a.alias_norm) DESC, a.alias_norm`,
      )
      .all() as AliasRow[];
    if (!options.includeCanonical) return rows;

    const seen = new Set(
      rows.map((row) => `${row.entity_id}\u0000${normalizeEntityAlias(row.alias_norm || row.alias)}`),
    );
    const entityRows = this.db.prepare('SELECT * FROM entity_registry').all() as EntityRow[];
    for (const entity of entityRows) {
      const aliasNorm = normalizeEntityAlias(entity.canonical_name);
      const key = `${entity.entity_id}\u0000${aliasNorm}`;
      if (!aliasNorm || seen.has(key)) continue;
      seen.add(key);
      rows.push({
        ...entity,
        alias: entity.canonical_name,
        alias_norm: aliasNorm,
      });
    }
    return rows.sort((a, b) => b.alias_norm.length - a.alias_norm.length || a.alias_norm.localeCompare(b.alias_norm));
  }

  private deleteMentions(docAnchors?: string[]): void {
    if (!docAnchors?.length) {
      this.db.exec('DELETE FROM entity_mentions');
      return;
    }
    const placeholders = docAnchors.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM entity_mentions WHERE doc_anchor IN (${placeholders})`).run(...docAnchors);
  }

  private selectDocs(docAnchors?: string[]): Array<{
    anchor: string;
    title: string;
    summary: string | null;
    keywords: string | null;
    updated_at: string;
  }> {
    let sql = 'SELECT anchor, title, summary, keywords, updated_at FROM evidence_docs';
    const params: string[] = [];
    if (docAnchors?.length) {
      sql += ` WHERE anchor IN (${docAnchors.map(() => '?').join(',')})`;
      params.push(...docAnchors);
    }
    return this.db.prepare(sql).all(...params) as Array<{
      anchor: string;
      title: string;
      summary: string | null;
      keywords: string | null;
      updated_at: string;
    }>;
  }

  private selectPassages(docAnchors?: string[]): Array<{
    doc_anchor: string;
    passage_id: string;
    content: string;
    created_at: string;
  }> {
    let sql = `
      SELECT p.doc_anchor, p.passage_id, p.content, p.created_at
      FROM evidence_passages p
      JOIN evidence_docs d ON d.anchor = p.doc_anchor
    `;
    const params: string[] = [];
    if (docAnchors?.length) {
      sql += ` WHERE p.doc_anchor IN (${docAnchors.map(() => '?').join(',')})`;
      params.push(...docAnchors);
    }
    return this.db.prepare(sql).all(...params) as Array<{
      doc_anchor: string;
      passage_id: string;
      content: string;
      created_at: string;
    }>;
  }

  private selectMentionPassageKeys(
    queryMatches: QueryEntityMatch[],
    limit: number,
    options?: { threadId?: string; dateFrom?: string; dateTo?: string },
  ): Array<{ doc_anchor: string; passage_id: string }> {
    if (limit <= 0) return [];
    const ids = [...new Set(queryMatches.map((m) => m.entityId))];
    const placeholders = ids.map(() => '?').join(',');
    const params: unknown[] = [...ids];
    let sql = `
      SELECT m.doc_anchor,
             m.passage_id,
             MAX(m.created_at) AS latest_mention_at,
             MAX(p.created_at) AS passage_created_at
      FROM entity_mentions m
      JOIN evidence_passages p ON p.doc_anchor = m.doc_anchor AND p.passage_id = m.passage_id
      WHERE m.entity_id IN (${placeholders})
        AND m.passage_id != ''
    `;
    if (options?.threadId) {
      sql += ' AND m.doc_anchor = ?';
      params.push(`thread-${options.threadId}`);
    }
    if (options?.dateFrom) {
      sql += ' AND p.created_at >= ?';
      params.push(options.dateFrom);
    }
    if (options?.dateTo) {
      sql += ' AND p.created_at <= ?';
      params.push(options.dateTo.length === 10 ? `${options.dateTo}T23:59:59` : options.dateTo);
    }
    sql += `
      GROUP BY m.doc_anchor, m.passage_id
      ORDER BY latest_mention_at DESC, passage_created_at DESC, m.doc_anchor, m.passage_id
      LIMIT ?
    `;
    params.push(limit);
    return this.db.prepare(sql).all(...params) as Array<{ doc_anchor: string; passage_id: string }>;
  }

  private selectMentionRowsForPassages(
    queryMatches: QueryEntityMatch[],
    passages: Array<{ doc_anchor: string; passage_id: string }>,
  ): Array<
    MentionRow & { content: string; speaker: string | null; position: number | null; created_at: string | null }
  > {
    if (passages.length === 0) return [];
    const ids = [...new Set(queryMatches.map((m) => m.entityId))];
    const idPlaceholders = ids.map(() => '?').join(',');
    const passageClauses = passages.map(() => '(m.doc_anchor = ? AND m.passage_id = ?)').join(' OR ');
    const params: unknown[] = [...ids, ...passages.flatMap((passage) => [passage.doc_anchor, passage.passage_id])];
    const rows = this.db
      .prepare(
        `SELECT r.*, m.surface, m.source, m.doc_anchor, m.passage_id,
                p.content, p.speaker, p.position, p.created_at
         FROM entity_mentions m
         JOIN entity_registry r ON r.entity_id = m.entity_id
         JOIN evidence_passages p ON p.doc_anchor = m.doc_anchor AND p.passage_id = m.passage_id
         WHERE m.entity_id IN (${idPlaceholders})
           AND (${passageClauses})
         ORDER BY m.created_at DESC, m.doc_anchor, m.passage_id`,
      )
      .all(...params) as Array<
      MentionRow & { content: string; speaker: string | null; position: number | null; created_at: string | null }
    >;
    return rows;
  }

  private selectMentionAnchors(
    queryMatches: QueryEntityMatch[],
    limit: number,
    filters?: EntityMentionDocFilters,
  ): string[] {
    if (limit <= 0) return [];
    const ids = [...new Set(queryMatches.map((m) => m.entityId))];
    const placeholders = ids.map(() => '?').join(',');
    const params: unknown[] = [...ids];
    let sql = `SELECT m.doc_anchor,
                      MAX(CASE WHEN m.source = 'passage' THEN 1 ELSE 0 END) AS has_passage,
                      MAX(m.created_at) AS latest_mention_at
               FROM entity_mentions m
               JOIN evidence_docs d ON d.anchor = m.doc_anchor
               WHERE m.entity_id IN (${placeholders})`;
    if (filters?.kind) {
      sql += ' AND d.kind = ?';
      params.push(filters.kind);
    }
    if (filters?.excludeSessionAndThread) {
      sql += " AND d.kind != 'session' AND d.kind != 'thread'";
    }
    if (filters?.excludePackKnowledge) {
      sql += " AND d.kind != 'pack-knowledge'";
    }
    if (filters?.status) {
      sql += ' AND d.status = ?';
      params.push(filters.status);
    }
    if (filters?.keywords?.length) {
      sql += ` AND (${filters.keywords.map(() => 'd.keywords LIKE ?').join(' OR ')})`;
      params.push(...filters.keywords.map((kw) => `%"${kw}"%`));
    }
    if (filters?.anchor) {
      sql += ' AND d.anchor = ?';
      params.push(filters.anchor);
    }
    if (filters?.dateFrom) {
      sql += ' AND d.updated_at >= ?';
      params.push(filters.dateFrom);
    }
    if (filters?.dateTo) {
      sql += ' AND d.updated_at <= ?';
      params.push(filters.dateTo.length === 10 ? `${filters.dateTo}T23:59:59` : filters.dateTo);
    }
    if (filters?.worldId) {
      sql += ' AND d.world_id = ?';
      params.push(filters.worldId);
    }
    if (filters?.sceneId) {
      sql += ' AND d.scene_id = ?';
      params.push(filters.sceneId);
    }
    if (filters?.provenanceTier) {
      sql += ' AND d.provenance_tier = ?';
      params.push(filters.provenanceTier);
    }
    if (filters?.suppressBackstop) {
      sql += " AND d.activation != 'backstop'";
    }
    sql += `
      GROUP BY m.doc_anchor
      ORDER BY has_passage DESC, latest_mention_at DESC, m.doc_anchor
      LIMIT ?
    `;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{ doc_anchor: string }>;
    return rows.map((row) => row.doc_anchor);
  }

  private selectMentionRowsForAnchors(
    queryMatches: QueryEntityMatch[],
    anchors: string[],
  ): Array<
    MentionRow & { content: string; speaker: string | null; position: number | null; created_at: string | null }
  > {
    if (anchors.length === 0) return [];
    const ids = [...new Set(queryMatches.map((m) => m.entityId))];
    const idPlaceholders = ids.map(() => '?').join(',');
    const anchorPlaceholders = anchors.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT r.*, m.surface, m.source, m.doc_anchor, m.passage_id,
                p.content, p.speaker, p.position, p.created_at
         FROM entity_mentions m
         JOIN entity_registry r ON r.entity_id = m.entity_id
         LEFT JOIN evidence_passages p ON p.doc_anchor = m.doc_anchor AND p.passage_id = m.passage_id
         WHERE m.entity_id IN (${idPlaceholders})
           AND m.doc_anchor IN (${anchorPlaceholders})
         ORDER BY (m.source = 'passage') DESC, m.created_at DESC`,
      )
      .all(...ids, ...anchors) as Array<
      MentionRow & { content: string; speaker: string | null; position: number | null; created_at: string | null }
    >;
    return rows;
  }
}

function toEntityMatch(row: MentionRow, queryMatch: QueryEntityMatch): EntityMatch {
  const passageId = row.passage_id || undefined;
  return {
    entityId: row.entity_id,
    type: row.entity_type as EntityType,
    canonicalName: row.canonical_name,
    matchedAlias: queryMatch.matchedAlias,
    surface: row.surface,
    source: row.source,
    docAnchor: row.doc_anchor,
    passageId,
    provenance: parseProvenance(row.provenance_json),
    why: `query alias ${queryMatch.matchedAlias} resolved to ${row.entity_id}; evidence contains ${row.surface}`,
  };
}

function parseProvenance(raw: string): EntityProvenance[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntityProvenance);
  } catch {
    return [];
  }
}

function isEntityProvenance(value: unknown): value is EntityProvenance {
  if (typeof value !== 'object' || value === null) return false;
  const source = (value as { source?: unknown }).source;
  return typeof source === 'string';
}

function hasCJK(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text);
}

function compileAliases(rows: AliasRow[]): CompiledAliasRow[] {
  const compiled: CompiledAliasRow[] = [];
  for (const row of rows) {
    const aliasNorm = normalizeEntityAlias(row.alias_norm || row.alias);
    const matcher = compileAliasMatcher(aliasNorm);
    if (!matcher) continue;
    compiled.push({ ...row, alias_norm: aliasNorm, matchesNormalizedText: matcher });
  }
  return compiled;
}

function compileAliasMatcher(aliasNorm: string): ((textNorm: string) => boolean) | null {
  if (!aliasNorm) return null;
  if (hasCJK(aliasNorm)) return (textNorm) => textNorm.includes(aliasNorm);

  const escaped = aliasNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_@-])${escaped}(?=$|[^\\p{L}\\p{N}_@-])`, 'u');
  return (textNorm) => pattern.test(textNorm);
}

function uniqueAliases(aliases: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const alias of aliases) {
    const norm = normalizeEntityAlias(alias);
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(alias);
  }
  return out;
}

function entitySeedUnchanged(
  existing: EntityRow | undefined,
  existingAliases: Array<{ alias: string; alias_norm: string }>,
  entity: EntityRecord,
  aliases: string[],
  provenanceJson: string,
): boolean {
  if (!existing) return false;
  if (existing.entity_type !== entity.type) return false;
  if (existing.canonical_name !== entity.canonicalName) return false;
  if (existing.provenance_json !== provenanceJson) return false;
  const currentAliases = existingAliases.map((row) => `${row.alias_norm}\u0000${row.alias}`).sort();
  const nextAliases = aliases.map((alias) => `${normalizeEntityAlias(alias)}\u0000${alias}`).sort();
  if (currentAliases.length !== nextAliases.length) return false;
  return currentAliases.every((alias, index) => alias === nextAliases[index]);
}
