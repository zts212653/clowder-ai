// F209 Phase A: passage-level vector CRUD for raw semantic / hybrid recall.

import type Database from 'better-sqlite3';

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
    private dim: number,
  ) {}

  upsert(passageKey: string, embedding: Float32Array): void {
    // Native UPDATE retains the slot; delete+insert leaves sparse chunk holes.
    this.db.transaction(() => {
      const updated = this.db
        .prepare('UPDATE passage_vectors SET embedding = ? WHERE passage_key = ?')
        .run(embedding, passageKey);
      if (!updated.changes)
        this.db
          .prepare('INSERT INTO passage_vectors (passage_key, embedding) VALUES (?, ?)')
          .run(passageKey, embedding);
    })();
  }

  delete(passageKey: string): void {
    this.db.prepare('DELETE FROM passage_vectors WHERE passage_key = ?').run(passageKey);
  }

  /** Read vec0's indexed key map without loading its vector BLOBs (also used by vector repacking). */
  existingKeys(keys: readonly string[]): Set<string> {
    if (keys.length === 0) return new Set();
    const rows = this.db
      .prepare(`SELECT id FROM passage_vectors_rowids WHERE id IN (${keys.map(() => '?').join(',')})`)
      .all(...keys) as Array<{ id: string }>;
    return new Set(rows.map(({ id }) => id));
  }

  search(queryVec: Float32Array, k: number): Array<{ passageKey: string; distance: number }> {
    return this.db
      .prepare(
        `SELECT passage_key as passageKey, distance FROM passage_vectors
      WHERE embedding MATCH ? AND k = ?`,
      )
      .all(queryVec, k) as Array<{ passageKey: string; distance: number }>;
  }

  clearAll(): void {
    this.db.exec('DELETE FROM passage_vectors');
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) as c FROM passage_vectors').get() as { c: number }).c;
  }
}
