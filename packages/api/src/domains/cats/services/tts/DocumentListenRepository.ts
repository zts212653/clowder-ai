import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ListenDocumentState, ListenRetention } from '@cat-cafe/shared';
import Database from 'better-sqlite3';

export interface ListenDocumentKey {
  userId: string;
  projectPath: string;
  relativePath: string;
}

export interface ListenAssetPolicy {
  assetId: string;
  lastUsedAt: number;
  expiresAt: number | null;
  referenceCount: number;
}

interface DocumentRow {
  id: number;
  content_digest: string;
  position_anchor: string | null;
  position_offset_seconds: number;
  playback_rate: number;
  retention: ListenRetention;
  updated_at: number;
}

interface SentenceRow {
  anchor: string;
  asset_id: string | null;
}

interface AssetRetentionRow {
  asset_id: string;
  last_used_at: number;
  asset_retention: ListenRetention;
  retention: ListenRetention | null;
}

const RETENTION_MS: Record<Exclude<ListenRetention, 'forever'>, number> = {
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

export class DocumentListenRepository {
  private db: Database.Database | null = null;

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    if (this.dbPath !== ':memory:') await mkdir(dirname(this.dbPath), { recursive: true });
    const db = new Database(this.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS listen_documents (
        id INTEGER PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        position_anchor TEXT,
        position_offset_seconds REAL NOT NULL DEFAULT 0,
        playback_rate REAL NOT NULL DEFAULT 1,
        retention TEXT NOT NULL DEFAULT '7d' CHECK (retention IN ('7d', '30d', 'forever')),
        updated_at INTEGER NOT NULL,
        UNIQUE(user_id, project_path, relative_path)
      );
      CREATE TABLE IF NOT EXISTS listen_assets (
        asset_id TEXT PRIMARY KEY,
        last_used_at INTEGER NOT NULL,
        retention TEXT NOT NULL DEFAULT '7d' CHECK (retention IN ('7d', '30d', 'forever'))
      );
      CREATE TABLE IF NOT EXISTS listen_sentence_assets (
        document_id INTEGER NOT NULL REFERENCES listen_documents(id) ON DELETE CASCADE,
        sentence_index INTEGER NOT NULL,
        anchor TEXT NOT NULL,
        asset_id TEXT REFERENCES listen_assets(asset_id) ON DELETE SET NULL,
        PRIMARY KEY(document_id, anchor),
        UNIQUE(document_id, sentence_index)
      );
      CREATE INDEX IF NOT EXISTS idx_listen_sentence_asset_id ON listen_sentence_assets(asset_id);
    `);
    const assetColumns = db.prepare('PRAGMA table_info(listen_assets)').all() as Array<{ name: string }>;
    if (!assetColumns.some(({ name }) => name === 'retention')) {
      db.exec(
        "ALTER TABLE listen_assets ADD COLUMN retention TEXT NOT NULL DEFAULT '7d' CHECK (retention IN ('7d', '30d', 'forever'))",
      );
    }
    this.db = db;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  saveDocument(key: ListenDocumentKey, state: ListenDocumentState): void {
    const db = this.ensureOpen();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO listen_documents (
           user_id, project_path, relative_path, content_digest, position_anchor,
           position_offset_seconds, playback_rate, retention, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, project_path, relative_path) DO UPDATE SET
           content_digest = excluded.content_digest,
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
        state.position.anchor,
        state.position.offsetSeconds,
        state.playbackRate,
        state.retention,
        state.updatedAt,
      );

      const documentId = this.requireDocument(key).id;
      const existing = new Map(
        (
          db
            .prepare('SELECT anchor, asset_id FROM listen_sentence_assets WHERE document_id = ?')
            .all(documentId) as SentenceRow[]
        )
          .filter((row) => row.asset_id)
          .map((row) => [row.anchor, row.asset_id as string]),
      );
      db.prepare('DELETE FROM listen_sentence_assets WHERE document_id = ?').run(documentId);
      const insert = db.prepare(
        'INSERT INTO listen_sentence_assets (document_id, sentence_index, anchor, asset_id) VALUES (?, ?, ?, ?)',
      );
      state.sentences.forEach((sentence, index) => {
        insert.run(documentId, index, sentence.anchor, sentence.assetId ?? existing.get(sentence.anchor) ?? null);
      });
      this.syncAssetRetentions([...new Set(existing.values())], state.retention);
    })();
  }

  loadDocument(key: ListenDocumentKey): ListenDocumentState | null {
    const db = this.ensureOpen();
    const row = db
      .prepare(
        `SELECT id, content_digest, position_anchor, position_offset_seconds,
                playback_rate, retention, updated_at
         FROM listen_documents WHERE user_id = ? AND project_path = ? AND relative_path = ?`,
      )
      .get(key.userId, key.projectPath, key.relativePath) as DocumentRow | undefined;
    if (!row) return null;
    const sentences = db
      .prepare('SELECT anchor, asset_id FROM listen_sentence_assets WHERE document_id = ? ORDER BY sentence_index ASC')
      .all(row.id) as SentenceRow[];
    return {
      identity: {
        projectPath: key.projectPath,
        relativePath: key.relativePath,
        contentDigest: row.content_digest,
      },
      sentences: sentences.map((sentence) => ({
        anchor: sentence.anchor,
        ...(sentence.asset_id ? { assetId: sentence.asset_id } : {}),
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
        .prepare('UPDATE listen_sentence_assets SET asset_id = ? WHERE document_id = ? AND anchor = ?')
        .run(assetId, document.id, anchor);
      if (result.changes !== 1) throw new Error(`Listen sentence not found: ${anchor}`);
      this.syncAssetRetentions(
        [...new Set([assetId, ...(previous?.asset_id ? [previous.asset_id] : [])])],
        document.retention,
      );
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
      this.syncAssetRetentions(assetIds, document.retention);
      const countReferences = db.prepare('SELECT COUNT(*) AS count FROM listen_sentence_assets WHERE asset_id = ?');
      return assetIds.filter((assetId) => {
        const row = countReferences.get(assetId) as { count: number };
        return row.count === 0;
      });
    })();
  }

  listAssetPolicies(): ListenAssetPolicy[] {
    const rows = this.ensureOpen()
      .prepare(
        `SELECT assets.asset_id, assets.last_used_at, assets.retention AS asset_retention, documents.retention
         FROM listen_assets assets
         LEFT JOIN listen_sentence_assets sentences ON sentences.asset_id = assets.asset_id
         LEFT JOIN listen_documents documents ON documents.id = sentences.document_id
         ORDER BY assets.asset_id`,
      )
      .all() as AssetRetentionRow[];
    const grouped = new Map<
      string,
      { lastUsedAt: number; assetRetention: ListenRetention; retentions: ListenRetention[] }
    >();
    for (const row of rows) {
      const entry = grouped.get(row.asset_id) ?? {
        lastUsedAt: row.last_used_at,
        assetRetention: row.asset_retention,
        retentions: [],
      };
      if (row.retention) entry.retentions.push(row.retention);
      grouped.set(row.asset_id, entry);
    }
    return [...grouped].map(([assetId, entry]) => ({
      assetId,
      lastUsedAt: entry.lastUsedAt,
      expiresAt: expirationFor(
        entry.lastUsedAt,
        entry.retentions.length > 0 ? entry.retentions : [entry.assetRetention],
      ),
      referenceCount: entry.retentions.length,
    }));
  }

  forgetAsset(assetId: string): void {
    const db = this.ensureOpen();
    db.transaction(() => {
      db.prepare('UPDATE listen_sentence_assets SET asset_id = NULL WHERE asset_id = ?').run(assetId);
      db.prepare('DELETE FROM listen_assets WHERE asset_id = ?').run(assetId);
    })();
  }

  private syncAssetRetentions(assetIds: string[], fallback: ListenRetention): void {
    const db = this.ensureOpen();
    const liveRetentions = db.prepare(
      `SELECT documents.retention
       FROM listen_sentence_assets sentences
       JOIN listen_documents documents ON documents.id = sentences.document_id
       WHERE sentences.asset_id = ?`,
    );
    const update = db.prepare('UPDATE listen_assets SET retention = ? WHERE asset_id = ?');
    for (const assetId of assetIds) {
      const rows = liveRetentions.all(assetId) as Array<{ retention: ListenRetention }>;
      update.run(
        strongestRetention(
          rows.map(({ retention }) => retention),
          fallback,
        ),
        assetId,
      );
    }
  }

  private requireDocument(key: ListenDocumentKey): { id: number; retention: ListenRetention } {
    const row = this.ensureOpen()
      .prepare(
        'SELECT id, retention FROM listen_documents WHERE user_id = ? AND project_path = ? AND relative_path = ?',
      )
      .get(key.userId, key.projectPath, key.relativePath) as { id: number; retention: ListenRetention } | undefined;
    if (!row) throw new Error(`Listen document not found: ${key.projectPath}/${key.relativePath}`);
    return row;
  }

  private ensureOpen(): Database.Database {
    if (!this.db) throw new Error('DocumentListenRepository not initialized');
    return this.db;
  }
}

function strongestRetention(retentions: ListenRetention[], fallback: ListenRetention): ListenRetention {
  if (retentions.includes('forever')) return 'forever';
  if (retentions.includes('30d')) return '30d';
  if (retentions.includes('7d')) return '7d';
  return fallback;
}

function expirationFor(lastUsedAt: number, retentions: ListenRetention[]): number | null {
  if (retentions.includes('forever')) return null;
  const retentionMs = retentions.reduce(
    (maximum, retention) => Math.max(maximum, retention === 'forever' ? 0 : RETENTION_MS[retention]),
    0,
  );
  return lastUsedAt + retentionMs;
}
