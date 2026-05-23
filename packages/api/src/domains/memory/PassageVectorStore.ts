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
    // vec0 does not support ON CONFLICT; mirror VectorStore's delete+insert.
    this.db.prepare('DELETE FROM passage_vectors WHERE passage_key = ?').run(passageKey);
    this.db.prepare('INSERT INTO passage_vectors (passage_key, embedding) VALUES (?, ?)').run(passageKey, embedding);
  }

  delete(passageKey: string): void {
    this.db.prepare('DELETE FROM passage_vectors WHERE passage_key = ?').run(passageKey);
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
