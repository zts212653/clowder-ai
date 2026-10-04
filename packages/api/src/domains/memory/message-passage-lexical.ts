import type Database from 'better-sqlite3';
import { buildProgressiveFtsQueries } from './fts-query-builder.js';
import { splitLexicalBackfillWords } from './lexical-backfill.js';
import type { MessagePassageSearchOptions } from './message-passage-search-types.js';
import type { PassageResult } from './SqliteEvidenceStore.js';

interface PassageRow extends PassageResult {
  rank: number;
}

function messageFilters(options: MessagePassageSearchOptions, anchors: Set<string>) {
  const clauses = [
    "d.kind = 'thread'",
    "p.passage_id LIKE 'msg-%'",
    `p.doc_anchor IN (${[...anchors].map(() => '?').join(',')})`,
  ];
  const params: unknown[] = [...anchors];
  if (options.excludeSource) {
    clauses.push('NOT (p.doc_anchor = ? AND p.passage_id = ?)');
    params.push(`thread-${options.excludeSource.threadId}`, `msg-${options.excludeSource.messageId}`);
  }
  if (options.dateFrom) {
    clauses.push('p.created_at >= ?');
    params.push(options.dateFrom);
  }
  if (options.dateTo) {
    clauses.push('p.created_at <= ?');
    params.push(options.dateTo);
  }
  return { sql: clauses.join(' AND '), params };
}

export function lexicalMessagePassages(
  db: Database.Database,
  query: string,
  options: MessagePassageSearchOptions,
  anchors: Set<string>,
  pool: number,
): PassageResult[] {
  if (anchors.size === 0) return [];
  const filter = messageFilters(options, anchors);
  const columns = `p.doc_anchor AS docAnchor, p.passage_id AS passageId,
    p.content, p.speaker, p.created_at AS createdAt`;
  const order =
    options.sort === 'relevance' ? 'rank, p.doc_anchor, p.passage_id' : 'p.created_at, p.doc_anchor, p.passage_id';
  let rows: PassageRow[] = [];
  for (const fts of buildProgressiveFtsQueries(query)) {
    rows = db
      .prepare(`SELECT ${columns}, bm25(passage_fts) AS rank
      FROM passage_fts f JOIN evidence_passages p ON p.rowid = f.rowid
      JOIN evidence_docs d ON d.anchor = p.doc_anchor
      WHERE passage_fts MATCH ? AND ${filter.sql} ORDER BY ${order} LIMIT ?`)
      .all(fts, ...filter.params, pool + 1) as PassageRow[];
    if (rows.length > 0) break;
  }
  // unicode61 treats a continuous Chinese sentence as one token. Recover
  // literal message substrings without changing the shared FTS index/tokenizer.
  const chineseTerms = splitLexicalBackfillWords(query).filter((term) => /[一-鿿㐀-䶿]/.test(term));
  if (chineseTerms.length > 0) {
    const contains = chineseTerms.map(() => 'instr(LOWER(p.content), ?) > 0').join(' OR ');
    const extra = db
      .prepare(`SELECT ${columns}, 0 AS rank
      FROM evidence_passages p JOIN evidence_docs d ON d.anchor = p.doc_anchor
      WHERE (${contains}) AND ${filter.sql} ORDER BY ${order} LIMIT ?`)
      .all(...chineseTerms, ...filter.params, pool + 1) as PassageRow[];
    const byIdentity = new Map(rows.map((row) => [JSON.stringify([row.docAnchor, row.passageId]), row]));
    for (const row of extra) {
      const key = JSON.stringify([row.docAnchor, row.passageId]);
      if (!byIdentity.has(key)) byIdentity.set(key, row);
    }
    rows = [...byIdentity.values()];
  }
  rows.sort(
    (a, b) =>
      (options.sort === 'relevance' ? a.rank - b.rank : (a.createdAt ?? '').localeCompare(b.createdAt ?? '')) ||
      a.docAnchor.localeCompare(b.docAnchor) ||
      a.passageId.localeCompare(b.passageId),
  );
  return rows.slice(0, pool + 1);
}
