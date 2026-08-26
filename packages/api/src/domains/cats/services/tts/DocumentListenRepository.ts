import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ListenDocumentState, ListenRetention } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { type ListenAssetPolicy, listAssetPolicies, syncAssetRetentions } from './DocumentListenRetention.js';
import { type DocumentRow, initializeDocumentListenSchema, type SentenceRow } from './DocumentListenSchema.js';

export interface ListenDocumentKey {
  userId: string;
  projectPath: string;
  relativePath: string;
}

export type { ListenAssetPolicy } from './DocumentListenRetention.js';

export class DocumentListenRepository {
  private db: Database.Database | null = null;

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    if (this.dbPath !== ':memory:') await mkdir(dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    initializeDocumentListenSchema(db);
    this.db = db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  saveDocument(key: ListenDocumentKey, state: ListenDocumentState): void {
    const db = this.ensureOpen();
    db.transaction(() => {
      const previousDocument = db
        .prepare(
          'SELECT content_digest, synthesis_fingerprint FROM listen_documents WHERE user_id = ? AND project_path = ? AND relative_path = ?',
        )
        .get(key.userId, key.projectPath, key.relativePath) as
        | Pick<DocumentRow, 'content_digest' | 'synthesis_fingerprint'>
        | undefined;
      const sameContent = previousDocument?.content_digest === state.identity.contentDigest;
      // An unavailable provider leaves the fingerprint unknown, not changed.
      // Preserve a same-digest manifest until a later authoritative fingerprint
      // can decide whether the links must be invalidated.
      const synthesisFingerprint =
        state.synthesisFingerprint ?? (sameContent ? previousDocument.synthesis_fingerprint : '');
      db.prepare(
        `INSERT INTO listen_documents (
           user_id, project_path, relative_path, content_digest, synthesis_fingerprint, position_anchor,
           position_offset_seconds, playback_rate, retention, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, project_path, relative_path) DO UPDATE SET
           content_digest = excluded.content_digest,
           synthesis_fingerprint = excluded.synthesis_fingerprint,
           position_anchor = excluded.position_anchor,
           position_offset_seconds = excluded.position_offset_seconds,
           playback_rate = excluded.playback_rate,
           retention = excluded.retention,
           updated_at = excluded.updated_at`,
      ).run(
        key.userId,
        key.projectPath,
        key.relativePath,
        state.identity.contentDigest,
        synthesisFingerprint,
        state.position.anchor,
        state.position.offsetSeconds,
        state.playbackRate,
        state.retention,
        state.updatedAt,
      );

      const documentId = this.requireDocument(key).id;
      const existing = new Map<string, { assetId: string; synthesisFingerprint: string }>(
        (
          db
            .prepare('SELECT anchor, asset_id, synthesis_fingerprint FROM listen_sentence_assets WHERE document_id = ?')
            .all(documentId) as SentenceRow[]
        )
          .filter((row) => row.asset_id)
          .map((row) => [
            row.anchor,
            { assetId: row.asset_id as string, synthesisFingerprint: row.synthesis_fingerprint },
          ]),
      );
      db.prepare('DELETE FROM listen_sentence_assets WHERE document_id = ?').run(documentId);
      const insert = db.prepare(
        'INSERT INTO listen_sentence_assets (document_id, sentence_index, anchor, asset_id, synthesis_fingerprint) VALUES (?, ?, ?, ?, ?)',
      );
      state.sentences.forEach((sentence, index) => {
        const previous = existing.get(sentence.anchor);
        // A digest changes for any document edit. The manifest anchor encodes
        // normalized sentence text and occurrence, so a matching anchor plus
        // fingerprint is the safe content-addressed reuse identity.
        const assetId =
          sentence.assetId ?? (previous?.synthesisFingerprint === synthesisFingerprint ? previous.assetId : null);
        insert.run(documentId, index, sentence.anchor, assetId, synthesisFingerprint);
      });
      syncAssetRetentions(db, [...new Set([...existing.values()].map(({ assetId }) => assetId))], state.retention);
    })();
  }

  loadDocument(key: ListenDocumentKey): ListenDocumentState | null {
    const db = this.ensureOpen();
    const row = db
      .prepare(
        `SELECT id, content_digest, synthesis_fingerprint, position_anchor, position_offset_seconds,
                playback_rate, retention, updated_at
         FROM listen_documents WHERE user_id = ? AND project_path = ? AND relative_path = ?`,
      )
      .get(key.userId, key.projectPath, key.relativePath) as DocumentRow | undefined;
    if (!row) return null;
    const sentences = db
      .prepare(
        'SELECT anchor, asset_id, synthesis_fingerprint FROM listen_sentence_assets WHERE document_id = ? ORDER BY sentence_index ASC',
      )
      .all(row.id) as SentenceRow[];
    return {
      identity: {
        projectPath: key.projectPath,
        relativePath: key.relativePath,
        contentDigest: row.content_digest,
      },
      ...(row.synthesis_fingerprint ? { synthesisFingerprint: row.synthesis_fingerprint } : {}),
      sentences: sentences.map((sentence) => ({
        anchor: sentence.anchor,
        ...(sentence.asset_id && sentence.synthesis_fingerprint === row.synthesis_fingerprint
          ? { assetId: sentence.asset_id }
          : {}),
      })),
      position: { anchor: row.position_anchor, offsetSeconds: row.position_offset_seconds },
      playbackRate: row.playback_rate as ListenDocumentState['playbackRate'],
      retention: row.retention,
      updatedAt: row.updated_at,
    };
  }

  setSentenceAsset(key: ListenDocumentKey, anchor: string, assetId: string, usedAt = Date.now()): void {
    const db = this.ensureOpen();
    db.transaction(() => {
      const document = this.requireDocument(key);
      const previous = db
        .prepare('SELECT asset_id FROM listen_sentence_assets WHERE document_id = ? AND anchor = ?')
        .get(document.id, anchor) as { asset_id: string | null } | undefined;
      this.registerAsset(assetId, usedAt, document.retention);
      const result = db
        .prepare(
          'UPDATE listen_sentence_assets SET asset_id = ?, synthesis_fingerprint = ? WHERE document_id = ? AND anchor = ?',
        )
        .run(assetId, document.synthesisFingerprint, document.id, anchor);
      if (result.changes !== 1) throw new Error(`Listen sentence not found: ${anchor}`);
      syncAssetRetentions(
        db,
        [...new Set([assetId, ...(previous?.asset_id ? [previous.asset_id] : [])])],
        document.retention,
      );
    })();
  }

  /**
   * Establishes the current cache identity before a server-owned run starts.
   * The incoming sentence text is deliberately absent here: only anchors/digest
   * enter durable state.
   */
  prepareCacheRun(
    key: ListenDocumentKey,
    contentDigest: string,
    synthesisFingerprint: string,
    anchors: string[],
  ): void {
    const db = this.ensureOpen();
    db.transaction(() => {
      const document = this.requireDocument(key);
      if (document.contentDigest !== contentDigest) throw new Error('Listen document digest is no longer current');
      const manifestAnchors = (
        db
          .prepare('SELECT anchor FROM listen_sentence_assets WHERE document_id = ? ORDER BY sentence_index ASC')
          .all(document.id) as Array<{ anchor: string }>
      ).map(({ anchor }) => anchor);
      if (
        anchors.length !== manifestAnchors.length ||
        anchors.some((anchor, index) => anchor !== manifestAnchors[index])
      ) {
        throw new Error('Listen sentence manifest no longer matches current document');
      }
      if (document.synthesisFingerprint === synthesisFingerprint) return;
      const oldAssetIds = (
        db
          .prepare(
            'SELECT DISTINCT asset_id FROM listen_sentence_assets WHERE document_id = ? AND asset_id IS NOT NULL',
          )
          .all(document.id) as Array<{ asset_id: string }>
      ).map(({ asset_id }) => asset_id);
      db.prepare('UPDATE listen_documents SET synthesis_fingerprint = ? WHERE id = ?').run(
        synthesisFingerprint,
        document.id,
      );
      db.prepare(
        'UPDATE listen_sentence_assets SET asset_id = NULL, synthesis_fingerprint = ? WHERE document_id = ?',
      ).run(synthesisFingerprint, document.id);
      syncAssetRetentions(db, oldAssetIds, document.retention);
    })();
  }

  /** Returns false instead of writing if a cancelled, edited, or stale run arrives late. */
  setSentenceAssetIfCurrent(
    key: ListenDocumentKey,
    input: { contentDigest: string; synthesisFingerprint: string; anchor: string; assetId: string; usedAt?: number },
  ): boolean {
    const db = this.ensureOpen();
    return db.transaction(() => {
      const document = this.requireDocument(key);
      if (
        document.contentDigest !== input.contentDigest ||
        document.synthesisFingerprint !== input.synthesisFingerprint
      ) {
        return false;
      }
      const previous = db
        .prepare('SELECT asset_id FROM listen_sentence_assets WHERE document_id = ? AND anchor = ?')
        .get(document.id, input.anchor) as { asset_id: string | null } | undefined;
      if (!previous) return false;
      this.registerAsset(input.assetId, input.usedAt, document.retention);
      const result = db
        .prepare(
          'UPDATE listen_sentence_assets SET asset_id = ?, synthesis_fingerprint = ? WHERE document_id = ? AND anchor = ?',
        )
        .run(input.assetId, input.synthesisFingerprint, document.id, input.anchor);
      if (result.changes !== 1) return false;
      syncAssetRetentions(
        db,
        [...new Set([input.assetId, ...(previous.asset_id ? [previous.asset_id] : [])])],
        document.retention,
      );
      return true;
    })();
  }

  registerAsset(assetId: string, usedAt = Date.now(), retention: ListenRetention = '7d'): void {
    this.ensureOpen()
      .prepare(
        `INSERT INTO listen_assets (asset_id, last_used_at, retention) VALUES (?, ?, ?)
         ON CONFLICT(asset_id) DO UPDATE SET last_used_at = MAX(last_used_at, excluded.last_used_at)`,
      )
      .run(assetId, usedAt, retention);
  }

  touchAsset(assetId: string, usedAt = Date.now()): void {
    this.ensureOpen()
      .prepare('UPDATE listen_assets SET last_used_at = MAX(last_used_at, ?) WHERE asset_id = ?')
      .run(usedAt, assetId);
  }

  clearDocumentAudio(key: ListenDocumentKey): string[] {
    const db = this.ensureOpen();
    return db.transaction(() => {
      const document = this.requireDocument(key);
      const assetIds = (
        db
          .prepare(
            'SELECT DISTINCT asset_id FROM listen_sentence_assets WHERE document_id = ? AND asset_id IS NOT NULL',
          )
          .all(document.id) as Array<{ asset_id: string }>
      ).map((row) => row.asset_id);
      db.prepare('UPDATE listen_sentence_assets SET asset_id = NULL WHERE document_id = ?').run(document.id);
      syncAssetRetentions(db, assetIds, document.retention);
      const countReferences = db.prepare('SELECT COUNT(*) AS count FROM listen_sentence_assets WHERE asset_id = ?');
      return assetIds.filter((assetId) => {
        const row = countReferences.get(assetId) as { count: number };
        return row.count === 0;
      });
    })();
  }

  listAssetPolicies(): ListenAssetPolicy[] {
    return listAssetPolicies(this.ensureOpen());
  }

  forgetAsset(assetId: string): void {
    const db = this.ensureOpen();
    db.transaction(() => {
      db.prepare('UPDATE listen_sentence_assets SET asset_id = NULL WHERE asset_id = ?').run(assetId);
      db.prepare('DELETE FROM listen_assets WHERE asset_id = ?').run(assetId);
    })();
  }

  private requireDocument(key: ListenDocumentKey): {
    id: number;
    contentDigest: string;
    synthesisFingerprint: string;
    retention: ListenRetention;
  } {
    const row = this.ensureOpen()
      .prepare(
        'SELECT id, content_digest, synthesis_fingerprint, retention FROM listen_documents WHERE user_id = ? AND project_path = ? AND relative_path = ?',
      )
      .get(key.userId, key.projectPath, key.relativePath) as
      | { id: number; content_digest: string; synthesis_fingerprint: string; retention: ListenRetention }
      | undefined;
    if (!row) throw new Error(`Listen document not found: ${key.projectPath}/${key.relativePath}`);
    return {
      id: row.id,
      contentDigest: row.content_digest,
      synthesisFingerprint: row.synthesis_fingerprint,
      retention: row.retention,
    };
  }

  private ensureOpen(): Database.Database {
    if (!this.db) throw new Error('DocumentListenRepository not initialized');
    return this.db;
  }
}
