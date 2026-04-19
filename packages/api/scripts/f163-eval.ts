#!/usr/bin/env npx tsx
/**
 * F163: Gold Set Evaluation Script
 * Runs queries from f163-gold-set.json against the SQLite evidence store,
 * computes NDCG@10 + MRR, and writes baseline to f163-baseline.json.
 *
 * Usage: npx tsx packages/api/scripts/f163-eval.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type GoldSet, runEvaluation } from '../src/domains/memory/f163-eval-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const goldSetPath = join(__dirname, 'f163-gold-set.json');
const baselinePath = join(__dirname, 'f163-baseline.json');

// Find the evidence.sqlite database
const dbPath = process.env['EVIDENCE_DB_PATH'] ?? join(__dirname, '../../../data/evidence.sqlite');

async function main() {
  console.log('F163 Eval — Loading gold set...');
  const goldSet: GoldSet = JSON.parse(readFileSync(goldSetPath, 'utf-8'));
  console.log(`  ${goldSet.queries.length} queries loaded`);

  let db: InstanceType<typeof Database>;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (err) {
    console.error(`Cannot open evidence.sqlite at ${dbPath}`);
    console.error('Set EVIDENCE_DB_PATH env var or ensure data/evidence.sqlite exists');
    console.error(String(err));
    process.exit(1);
  }

  // Check if evidence_docs table exists
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evidence_docs'").get() as
    | { name: string }
    | undefined;
  if (!tableCheck) {
    console.error('evidence_docs table not found — is the database initialized?');
    process.exit(1);
  }

  const docCount = (db.prepare('SELECT count(*) AS c FROM evidence_docs').get() as { c: number }).c;
  console.log(`  ${docCount} documents in evidence store`);

  // Search function using BM25 FTS5
  const searchFn = async (query: string, opts?: { limit?: number }) => {
    const limit = opts?.limit ?? 10;
    try {
      // Try FTS5 search first
      const rows = db
        .prepare(
          `SELECT d.anchor, d.title, d.kind, d.status, d.updated_at
           FROM evidence_fts f
           JOIN evidence_docs d ON d.rowid = f.rowid
           WHERE evidence_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(query, limit) as Array<{
        anchor: string;
        title: string;
        kind: string;
        status: string;
        updated_at: string;
      }>;
      return rows;
    } catch {
      // Fallback to LIKE search if FTS query syntax fails
      const likePattern = `%${query}%`;
      const rows = db
        .prepare(
          `SELECT anchor, title, kind, status, updated_at
           FROM evidence_docs
           WHERE title LIKE ? OR summary LIKE ?
           LIMIT ?`,
        )
        .all(likePattern, likePattern, limit) as Array<{
        anchor: string;
        title: string;
        kind: string;
        status: string;
        updated_at: string;
      }>;
      return rows;
    }
  };

  console.log('\nRunning evaluation...');
  const result = await runEvaluation(goldSet, searchFn);

  console.log(`\n=== F163 Evaluation Results ===`);
  console.log(`Queries:    ${result.queryCount}`);
  console.log(`NDCG@10:    ${result.meanNDCG.toFixed(4)}`);
  console.log(`MRR:        ${result.meanMRR.toFixed(4)}`);

  // Per-query breakdown for misses
  const misses = result.perQuery.filter((pq) => pq.ndcg === 0);
  if (misses.length > 0) {
    console.log(`\n--- Queries with NDCG=0 (${misses.length}) ---`);
    for (const m of misses.slice(0, 10)) {
      console.log(`  "${m.query}" → returned: [${m.returnedAnchors.slice(0, 3).join(', ')}]`);
    }
  }

  // Write baseline
  const baseline = {
    version: 1,
    evaluatedAt: new Date().toISOString(),
    goldSetVersion: goldSet.version,
    queryCount: result.queryCount,
    docCount,
    meanNDCG: Number(result.meanNDCG.toFixed(4)),
    meanMRR: Number(result.meanMRR.toFixed(4)),
    flags: 'all_off',
  };

  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`\nBaseline written to ${baselinePath}`);

  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
