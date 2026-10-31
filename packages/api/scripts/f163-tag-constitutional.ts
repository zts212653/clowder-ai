#!/usr/bin/env npx tsx
/**
 * F163: Tag existing constitutional knowledge in evidence.sqlite
 * Marks shared-rules, SOP, P0 lessons, and ADRs as authority=constitutional.
 *
 * Usage: npx tsx packages/api/scripts/f163-tag-constitutional.ts
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { tagConstitutional } from '../src/domains/memory/f163-tag-constitutional.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env['EVIDENCE_DB_PATH'] ?? join(__dirname, '../../../data/evidence.sqlite');

function main() {
  console.log('F163 Tag Constitutional — Opening evidence.sqlite...');
  const db = new Database(dbPath);

  const docCount = (db.prepare('SELECT count(*) AS c FROM evidence_docs').get() as { c: number }).c;
  console.log(`  ${docCount} documents in evidence store`);

  const result = tagConstitutional(db);

  console.log(`\n=== Results ===`);
  console.log(`Tagged:   ${result.tagged}`);
  console.log(`Skipped:  ${result.skipped} (pattern not found in DB)`);
  console.log(`Patterns: ${result.patterns.join(', ')}`);

  // Show tagged docs
  const tagged = db
    .prepare("SELECT anchor, title, authority, activation FROM evidence_docs WHERE authority = 'constitutional'")
    .all() as Array<{ anchor: string; title: string; authority: string; activation: string }>;

  if (tagged.length > 0) {
    console.log(`\n--- Constitutional docs (${tagged.length}) ---`);
    for (const doc of tagged) {
      console.log(`  [${doc.authority}/${doc.activation}] ${doc.anchor} — ${doc.title}`);
    }
  }

  db.close();
}

main();
