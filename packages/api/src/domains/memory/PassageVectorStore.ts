// F209 Phase A: passage-level vector CRUD for raw semantic / hybrid recall.

import type Database from 'better-sqlite3';
import type { FileVectorQueryReader } from './file-vector-read-window.js';
import { generationInvalidationCurrent, generationInvalidationState } from './vector-generation-invalidation.js';
import {
  type VectorGenerationTables,
  validateVectorGenerationTables,
  vectorGenerationTables,
} from './vector-generation-tables.js';

export function passageVectorKey(docAnchor: string, passageId: string): string {
  return JSON.stringify([docAnchor, passageId]);
}

export function parsePassageVectorKey(key: string): { docAnchor: string; passageId: string } {
  const parsed = JSON.parse(key) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
    throw new Error(`Invalid passage vector key: ${key}`);
  }
  return { docAnchor: parsed[0], passageId: parsed[1] };
}

export class PassageVectorStore {
  constructor(
    private db: Database.Database,
    _dim: number,
    private readonly readQuery: FileVectorQueryReader = (query) => query(),
    tables: VectorGenerationTables = vectorGenerationTables(),
  ) {
    this.tables = validateVectorGenerationTables(tables);
  }

  readonly tables: VectorGenerationTables;

  upsert(passageKey: string, embedding: Float32Array): void {
    // Native UPDATE retains the slot; delete+insert leaves sparse chunk holes.
    this.db.transaction(() => {
      const updated = this.db
        .prepare(`UPDATE ${this.tables.passages} SET embedding = ? WHERE passage_key = ?`)
        .run(embedding, passageKey);
      if (!updated.changes)
        this.db
          .prepare(`INSERT INTO ${this.tables.passages} (passage_key, embedding) VALUES (?, ?)`)
          .run(passageKey, embedding);
    })();
  }

  delete(passageKey: string): void {
    this.db.prepare(`DELETE FROM ${this.tables.passages} WHERE passage_key = ?`).run(passageKey);
  }

  /** Read vec0's indexed key map without loading its vector BLOBs (also used by vector repacking). */
  existingKeys(keys: readonly string[]): Set<string> {
    if (keys.length === 0) return new Set();
    const rows = this.db
      .prepare(`SELECT id FROM ${this.tables.passages}_rowids WHERE id IN (${keys.map(() => '?').join(',')})`)
      .all(...keys) as Array<{ id: string }>;
    return new Set(rows.map(({ id }) => id));
  }

  search(queryVec: Float32Array, k: number): Array<{ passageKey: string; distance: number }> {
    const captured = generationInvalidationState(this.db, this.tables);
    if (captured.quarantined) return [];
    const statement = this.db.prepare(
      `SELECT passage_key as passageKey, distance FROM ${this.tables.passages}
      WHERE embedding MATCH ? AND k = ?`,
    );
    const rows = this.readQuery(() => statement.all(queryVec, k)) as Array<{ passageKey: string; distance: number }>;
    return generationInvalidationCurrent(this.db, this.tables, captured) ? rows : [];
  }

  clearAll(): void {
    this.db.exec(`DELETE FROM ${this.tables.passages}`);
  }

  count(): number {
    return (this.db.prepare(`SELECT count(*) as c FROM ${this.tables.passages}`).get() as { c: number }).c;
  }
}
