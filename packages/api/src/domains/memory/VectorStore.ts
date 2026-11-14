// F102 Phase C: VectorStore — vec0 CRUD + embedding_meta version anchor
// AC-C3 (vec0 operations), AC-C6 (version anchor consistency check)

import type Database from 'better-sqlite3';
import type { EmbedModelInfo } from './interfaces.js';
import { generationInvalidationCurrent, generationInvalidationState } from './vector-generation-invalidation.js';
import {
  type VectorGenerationTables,
  validateVectorGenerationTables,
  vectorGenerationTables,
} from './vector-generation-tables.js';

export class VectorStore {
  constructor(
    private db: Database.Database,
    private dim: number,
    tables: VectorGenerationTables = vectorGenerationTables(),
  ) {
    this.tables = validateVectorGenerationTables(tables);
  }

  readonly tables: VectorGenerationTables;

  upsert(anchor: string, embedding: Float32Array): void {
    // vec0 supports native UPDATE, but not ON CONFLICT. Keep existing slots.
    this.db.transaction(() => {
      const updated = this.db
        .prepare(`UPDATE ${this.tables.documents} SET embedding = ? WHERE anchor = ?`)
        .run(embedding, anchor);
      if (!updated.changes)
        this.db
          .prepare(`INSERT INTO ${this.tables.documents} (anchor, embedding) VALUES (?, ?)`)
          .run(anchor, embedding);
    })();
  }

  delete(anchor: string): void {
    this.db.prepare(`DELETE FROM ${this.tables.documents} WHERE anchor = ?`).run(anchor);
  }

  search(queryVec: Float32Array, k: number): Array<{ anchor: string; distance: number }> {
    const captured = generationInvalidationState(this.db, this.tables);
    if (captured.quarantined) return [];
    const rows = this.db
      .prepare(
        `SELECT anchor, distance FROM ${this.tables.documents}
      WHERE embedding MATCH ? AND k = ?`,
      )
      .all(queryVec, k) as Array<{ anchor: string; distance: number }>;
    return generationInvalidationCurrent(this.db, this.tables, captured) ? rows : [];
  }

  initMeta(info: EmbedModelInfo): void {
    const upsert = this.db.prepare(`INSERT OR REPLACE INTO ${this.tables.metadata} (key, value) VALUES (?, ?)`);
    const tx = this.db.transaction(() => {
      upsert.run('embedding_model_id', info.modelId);
      upsert.run('embedding_model_rev', info.modelRev);
      upsert.run('embedding_dim', String(info.dim));
      if (info.representationFingerprint)
        upsert.run('embedding_representation_fingerprint', info.representationFingerprint);
    });
    tx();
  }

  getMeta(): Record<string, string> {
    const rows = this.db.prepare(`SELECT key, value FROM ${this.tables.metadata}`).all() as Array<{
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
    if (
      current.representationFingerprint &&
      meta.embedding_representation_fingerprint !== current.representationFingerprint
    )
      return { consistent: false, reason: 'representation changed or unknown' };
    return { consistent: true, reason: 'ok' };
  }

  clearAll(): void {
    this.db.exec(`DELETE FROM ${this.tables.documents}`);
    // Scanner bookkeeping shares this table but is independent of vector/model lifetime.
    this.db.exec(
      `DELETE FROM ${this.tables.metadata} WHERE key NOT IN ('indexing_version', 'document_source_claims','vector_invalidation_epoch','vector_invalidation_quarantined')`,
    );
  }

  count(): number {
    return (this.db.prepare(`SELECT count(*) as c FROM ${this.tables.documents}`).get() as { c: number }).c;
  }
}
