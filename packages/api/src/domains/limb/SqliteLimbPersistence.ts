/**
 * SqliteLimbPersistence — #331 Limb state persistence
 *
 * Write-through SQLite backing for LimbPairingStore and LimbAccessPolicy.
 * Follows SqliteEvidenceStore pattern: lazy init, WAL mode, versioned migrations.
 */

import Database from 'better-sqlite3';
import type { LimbAccessEntry } from '@cat-cafe/shared';
import type { PairingRequest } from './LimbPairingStore.js';

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS limb_schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS limb_pairings (
  requestId TEXT PRIMARY KEY,
  nodeId TEXT NOT NULL,
  displayName TEXT NOT NULL,
  platform TEXT NOT NULL,
  endpointUrl TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  decidedAt INTEGER,
  apiKey TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS limb_access_policies (
  catId TEXT NOT NULL,
  nodeId TEXT NOT NULL,
  capability TEXT NOT NULL,
  authLevel TEXT NOT NULL,
  PRIMARY KEY (catId, nodeId, capability)
);
`;

export class SqliteLimbPersistence {
  private db: Database.Database | null = null;
  private readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  initialize(): void {
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.applyMigrations();
  }

  private applyMigrations(): void {
    const db = this.getDb();
    const version =
      (() => {
        try {
          return (db.prepare('SELECT MAX(version) as v FROM limb_schema_version').get() as { v: number | null })?.v ?? 0;
        } catch {
          return 0;
        }
      })();

    if (version < 1) {
      db.exec(SCHEMA_V1);
      db.prepare('INSERT INTO limb_schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    }
  }

  private getDb(): Database.Database {
    if (!this.db) throw new Error('SqliteLimbPersistence not initialized — call initialize() first');
    return this.db;
  }

  upsertPairing(p: PairingRequest): void {
    this.getDb()
      .prepare(
        `INSERT INTO limb_pairings (requestId, nodeId, displayName, platform, endpointUrl, capabilities, status, createdAt, decidedAt, apiKey)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(requestId) DO UPDATE SET
           nodeId=excluded.nodeId, displayName=excluded.displayName, platform=excluded.platform,
           endpointUrl=excluded.endpointUrl, capabilities=excluded.capabilities, status=excluded.status,
           decidedAt=excluded.decidedAt, apiKey=excluded.apiKey`,
      )
      .run(
        p.requestId,
        p.nodeId,
        p.displayName,
        p.platform,
        p.endpointUrl,
        JSON.stringify(p.capabilities),
        p.status,
        p.createdAt,
        p.decidedAt ?? null,
        p.apiKey,
      );
  }

  deletePairing(requestId: string): void {
    this.getDb().prepare('DELETE FROM limb_pairings WHERE requestId = ?').run(requestId);
  }

  loadPairings(): PairingRequest[] {
    const rows = this.getDb().prepare('SELECT * FROM limb_pairings').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      requestId: r.requestId as string,
      nodeId: r.nodeId as string,
      displayName: r.displayName as string,
      platform: r.platform as string,
      endpointUrl: r.endpointUrl as string,
      capabilities: JSON.parse(r.capabilities as string),
      status: r.status as PairingRequest['status'],
      createdAt: r.createdAt as number,
      decidedAt: (r.decidedAt as number | null) ?? undefined,
      apiKey: r.apiKey as string,
    }));
  }

  upsertAccessPolicy(e: LimbAccessEntry): void {
    this.getDb()
      .prepare(
        `INSERT INTO limb_access_policies (catId, nodeId, capability, authLevel)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(catId, nodeId, capability) DO UPDATE SET authLevel=excluded.authLevel`,
      )
      .run(e.catId, e.nodeId, e.capability, e.authLevel);
  }

  loadAccessPolicies(): LimbAccessEntry[] {
    const rows = this.getDb().prepare('SELECT * FROM limb_access_policies').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      catId: r.catId as string,
      nodeId: r.nodeId as string,
      capability: r.capability as string,
      authLevel: r.authLevel as LimbAccessEntry['authLevel'],
    }));
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}
