import type Database from 'better-sqlite3';
import { buildProgressiveFtsQueries } from './fts-query-builder.js';
import { observeCjkRead } from './message-cjk-read-diagnostics.js';
import { messageLiteralRelevance } from './message-literal-relevance.js';
import type { MessagePassageSearchOptions } from './message-passage-search-types.js';
import type { PassageResult } from './SqliteEvidenceStore.js';

interface PassageRow extends PassageResult {
  rank: number;
}

function compareRows(
  a: PassageRow,
  b: PassageRow,
  sort: MessagePassageSearchOptions['sort'],
  literal: ReturnType<typeof messageLiteralRelevance>,
): number {
  const relevance = sort === 'relevance';
  const primary = relevance
    ? (literal?.compareLexical(a, b) ?? 0) || a.rank - b.rank
    : (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  return primary || a.docAnchor.localeCompare(b.docAnchor) || a.passageId.localeCompare(b.passageId);
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
  const literal = messageLiteralRelevance(query);
  const cjk = literal && options.onCjkRead ? observeCjkRead(options.onCjkRead) : undefined;
  if (literal) {
    // Connection-local functions are rebound during this synchronous query;
    // registration writes no schema/data and also works in read-only workers.
    db.function('message_literal_coverage', { deterministic: true }, literal.coverageFolded);
    db.function(
      'message_cjk_match',
      { deterministic: true },
      cjk?.wrap(literal.matchesChineseFolded) ?? literal.matchesChineseFolded,
    );
  }
  const ranked = options.sort === 'relevance' ? literal : undefined;
  const literalColumns = ranked ? `${ranked.selectSql},` : '';
  const columns = `p.doc_anchor AS docAnchor, p.passage_id AS passageId,
    p.content, p.speaker, p.created_at AS createdAt`;
  const order =
    options.sort === 'relevance'
      ? `${literal ? 'literalCoverage DESC, literalSpecificity DESC,' : ''} rank, p.doc_anchor, p.passage_id`
      : 'p.created_at, p.doc_anchor, p.passage_id';
  let rows: PassageRow[] = [];
  // Keep the inverted index outermost. A thread-first plan restarts MATCH and
  // BM25 for each source row, multiplying the cost of long FTS queries.
  for (const fts of buildProgressiveFtsQueries(query)) {
    rows = db
      .prepare(`SELECT ${columns}, ${literalColumns} bm25(passage_fts) AS rank
      FROM passage_fts f CROSS JOIN evidence_passages p ON p.rowid = f.rowid
      CROSS JOIN evidence_docs d ON d.anchor = p.doc_anchor
      WHERE passage_fts MATCH ? AND ${filter.sql} ORDER BY ${order} LIMIT ?`)
      .all(...(ranked?.params ?? []), fts, ...filter.params, pool + 1) as PassageRow[];
    if (rows.length > 0) break;
  }
  // unicode61 treats a continuous Chinese sentence as one token. Recover
  // literal message substrings without changing the shared FTS index/tokenizer.
  if (literal) {
    // SQLite may run the matcher before other WHERE terms. CASE keeps rejected
    // bodies out of the callback; the outer filter retains native index choices.
    // Numbered parameters reuse the same bindings in both copies of the filter.
    const rankedParams = ranked?.params ?? [];
    let parameter = rankedParams.length;
    const admitted = filter.sql.replace(/\?/g, () => `?${++parameter}`);
    const bindings = Object.fromEntries(
      filter.params.map((value, index) => [String(rankedParams.length + index + 1), value]),
    );
    const readExtra = () =>
      db
        .prepare(`SELECT ${columns}, ${literalColumns} 0 AS rank
      FROM evidence_passages p JOIN evidence_docs d ON d.anchor = p.doc_anchor
      WHERE ${admitted} AND CASE WHEN ${admitted}
        THEN message_cjk_match(LOWER(p.content)) ELSE 0 END ORDER BY ${order} LIMIT ?`)
        .all(bindings, ...rankedParams, pool + 1) as PassageRow[];
    const extra = cjk ? cjk.read(readExtra) : readExtra();
    // FTS wins duplicate identities, retaining BM25 as the final score tie-breaker.
    rows = [
      ...new Map([...extra, ...rows].map((row) => [JSON.stringify([row.docAnchor, row.passageId]), row])).values(),
    ];
  }
  rows.sort((a, b) => compareRows(a, b, options.sort, literal));
  return rows.slice(0, pool + 1);
}
