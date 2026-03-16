// F102 Phase C: VectorStore — vec0 CRUD + embedding_meta version anchor
// AC-C3 (vec0 operations), AC-C6 (version anchor consistency check)

import type Database from 'better-sqlite3';
import type { EmbedModelInfo } from './interfaces.js';

export class VectorStore {
  constructor(
    private db: Database.Database,
    private dim: number,
  ) {}

  upsert(anchor: string, embedding: Float32Array): void {
    // vec0 doesn't support ON CONFLICT — use DELETE + INSERT
    this.db.prepare('DELETE FROM evidence_vectors WHERE anchor = ?').run(anchor);
    this.db.prepare('INSERT INTO evidence_vectors (anchor, embedding) VALUES (?, ?)').run(anchor, embedding);
  }

  delete(anchor: string): void {
    this.db.prepare('DELETE FROM evidence_vectors WHERE anchor = ?').run(anchor);
  }

  search(queryVec: Float32Array, k: number): Array<{ anchor: string; distance: number }> {
    return this.db
      .prepare(
        `SELECT anchor, distance FROM evidence_vectors
      WHERE embedding MATCH ? AND k = ?`,
      )
      .all(queryVec, k) as Array<{ anchor: string; distance: number }>;
  }

  initMeta(info: EmbedModelInfo): void {
    const upsert = this.db.prepare('INSERT OR REPLACE INTO embedding_meta (key, value) VALUES (?, ?)');
    const tx = this.db.transaction(() => {
      upsert.run('embedding_model_id', info.modelId);
      upsert.run('embedding_model_rev', info.modelRev);
      upsert.run('embedding_dim', String(info.dim));
    });
    tx();
  }

  getMeta(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM embedding_meta').all() as Array<{
      key: string;
      value: string;
    }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  checkMetaConsistency(current: EmbedModelInfo): { consistent: boolean; reason: string } {
    const meta = this.getMeta();
    if (!meta.embedding_model_id) return { consistent: true, reason: 'no prior meta' };
    if (meta.embedding_model_id !== current.modelId)
      return { consistent: false, reason: `model changed: ${meta.embedding_model_id} → ${current.modelId}` };
    if (meta.embedding_dim !== String(current.dim))
      return { consistent: false, reason: `dim changed: ${meta.embedding_dim} → ${current.dim}` };
    return { consistent: true, reason: 'ok' };
  }

  clearAll(): void {
    this.db.exec('DELETE FROM evidence_vectors');
    this.db.exec('DELETE FROM embedding_meta');
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) as c FROM evidence_vectors').get() as { c: number }).c;
  }
}
