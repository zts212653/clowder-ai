import type Database from 'better-sqlite3';
import { PASSAGE_FTS_TRIGGER_STATEMENTS, SCHEMA_V3_FTS } from './schema.js';

const normalizeSql = (sql: string): string =>
  sql
    .replace(/\bIF NOT EXISTS\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
function canonicalTrigger(sql: string): [string, string] {
  const name = sql.match(/CREATE TRIGGER IF NOT EXISTS (\w+)/)?.[1];
  if (!name) throw new Error('Canonical passage trigger has no name');
  return [name, normalizeSql(sql)];
}
const expected = new Map<string, string>([
  ['passage_fts', normalizeSql(SCHEMA_V3_FTS)],
  ...PASSAGE_FTS_TRIGGER_STATEMENTS.map(canonicalTrigger),
]);

function hasLargeMessageScope(db: Database.Database, filter: { sql: string; params: readonly unknown[] }): boolean {
  // A bounded, body-free strategy probe. Small/date-filtered source ranges
  // already have an efficient native index path; do not scan global vocabulary
  // for them. This LIMIT never limits candidates or the final globally sorted read.
  return Boolean(
    db
      .prepare(`SELECT 1 FROM evidence_passages p JOIN evidence_docs d ON d.anchor=p.doc_anchor
        WHERE ${filter.sql} LIMIT 1 OFFSET 8192`)
      .get(...filter.params),
  );
}

/** Reuse the canonical, transactionally maintained index; never create a persistent projection. */
function canReadVocabulary(db: Database.Database): boolean {
  const rows = db
    .prepare(`SELECT name,sql FROM main.sqlite_master
      WHERE name IN ('passage_fts','passage_fts_docsize','evidence_passages_ai','evidence_passages_ad','evidence_passages_au')`)
    .all() as Array<{ name: string; sql: string | null }>;
  const schema = new Map(rows.map((row) => [row.name, row.sql]));
  return (
    schema.has('passage_fts_docsize') &&
    [...expected].every(([name, sql]) => {
      const actual = schema.get(name);
      return typeof actual === 'string' && normalizeSql(actual) === sql;
    })
  );
}

/** A necessary rowid set only. Full literal matching, admission and ordering stay with the caller. */
export function messageCjkPassageSource(
  db: Database.Database,
  needleParameter: number,
  needleCount: number,
  filter: { sql: string; params: readonly unknown[] },
): string {
  if (needleCount < 1 || needleCount > 4 || !hasLargeMessageScope(db, filter) || !canReadVocabulary(db))
    return 'evidence_passages p JOIN evidence_docs d ON d.anchor = p.doc_anchor';
  // TEMP virtual tables expose this connection's existing index, including
  // readonly workers. They neither copy bodies nor build an index in main.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.message_cjk_terms USING fts5vocab(main,passage_fts,'row');
    CREATE VIRTUAL TABLE IF NOT EXISTS temp.message_cjk_instances USING fts5vocab(main,passage_fts,'instance')`);
  const terms = Array.from(
    { length: needleCount },
    (_, index) => `instr(v.term,json_extract(?${needleParameter},'$[${index}]')) > 0`,
  ).join(' OR ');
  // SQLite truncates indexed tokens at FTS5_MAX_TOKEN_SIZE (32768 bytes).
  // A required substring may lie beyond that boundary: visit every document
  // carrying such a token, then let the original full-body matcher decide.
  // Missing docsize rows likewise retain the existing literal recovery path.
  return `(SELECT i.doc AS rowid FROM temp.message_cjk_terms v CROSS JOIN temp.message_cjk_instances i ON i.term=v.term
      WHERE (${terms}) OR length(CAST(v.term AS BLOB)) >= 32768
    UNION
    SELECT missing.rowid FROM evidence_passages missing
      LEFT JOIN passage_fts_docsize size_row ON size_row.id=missing.rowid WHERE size_row.id IS NULL
  ) candidates CROSS JOIN evidence_passages p ON p.rowid=candidates.rowid
    CROSS JOIN evidence_docs d ON d.anchor=p.doc_anchor`;
}
