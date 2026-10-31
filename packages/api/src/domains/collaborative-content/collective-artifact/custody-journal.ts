import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  COLLECTIVE_CUSTODY_MAX_BYTES,
  COLLECTIVE_CUSTODY_PAGE_BYTES,
  type CollectiveArtifactCustodyTransfer,
  type CollectiveCustodyManifest,
  type CollectiveCustodyPage,
  collectiveCustodyManifestSchema,
  collectiveCustodyPageSchema,
  collectiveCustodyTransferSchema,
} from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { digestBytes } from '../../video-studio/content-owner/store.js';

const entrySchema = z
  .object({
    transfer: collectiveCustodyTransferSchema,
    role: z.enum(['source', 'target']),
    scopeRef: z.string().min(1).max(256),
    phase: z.enum([
      'source_archived',
      'source_prepared',
      'source_retired',
      'target_staging',
      'target_ready',
      'target_installed',
      'target_active',
      'cancelled',
    ]),
    manifest: collectiveCustodyManifestSchema,
    preparedRef: z.string().min(1).max(256),
    readyRef: z.string().min(1).max(256).optional(),
  })
  .strict();
export type CollectiveCustodyJournalEntry = z.infer<typeof entrySchema>;
type Row = { body: string; archive: Buffer | null };

/** Owner-local durable archive/staging, never Channel/outbox or Service state. No TTL. */
export class CollectiveArtifactTransferJournal {
  private readonly path: string;
  constructor(dataDir: string) {
    this.path = join(dataDir, 'projects', 'content-owner-v1', '.collective-transfers', 'journal.sqlite');
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.withDatabase((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS collective_artifact_transfers(
        transfer_id TEXT PRIMARY KEY, content_ref TEXT NOT NULL, body TEXT NOT NULL, archive BLOB);
        CREATE TABLE IF NOT EXISTS collective_artifact_transfer_pages(
          transfer_id TEXT NOT NULL, page_index INTEGER NOT NULL, digest TEXT NOT NULL, bytes BLOB NOT NULL,
          PRIMARY KEY(transfer_id,page_index));
        CREATE TABLE IF NOT EXISTS collective_artifact_transfer_reservations(
          content_ref TEXT PRIMARY KEY, transfer_id TEXT NOT NULL);`);
    });
    chmodSync(this.path, 0o600);
  }
  get(transfer: CollectiveArtifactCustodyTransfer): CollectiveCustodyJournalEntry | null {
    return this.withDatabase((db) => this.read(db, transfer)?.entry ?? null);
  }
  saveSource(entry: CollectiveCustodyJournalEntry, archive: Buffer) {
    if (
      entry.role !== 'source' ||
      archive.byteLength > COLLECTIVE_CUSTODY_MAX_BYTES ||
      digestBytes(archive) !== entry.manifest.digest ||
      archive.byteLength !== entry.manifest.totalBytes
    )
      throw new Error('Invalid Collective source archive');
    this.withDatabase((db) => {
      const prior = this.read(db, entry.transfer);
      if (prior) {
        if (isDeepStrictEqual(prior.entry.manifest, entry.manifest) && prior.archive?.equals(archive)) return;
        throw new Error('Collective source archive changed');
      }
      this.reserve(db, entry.transfer, 'source');
      db.prepare(
        'INSERT INTO collective_artifact_transfers VALUES(?,?,?,?) ON CONFLICT(transfer_id) DO UPDATE SET body=excluded.body,archive=excluded.archive',
      ).run(
        entry.transfer.transferId,
        entry.transfer.version.contentRef,
        JSON.stringify(entrySchema.parse(entry)),
        archive,
      );
    });
  }
  validatePage(entry: CollectiveCustodyJournalEntry, unsafe: CollectiveCustodyPage) {
    const page = collectiveCustodyPageSchema.parse(unsafe);
    const bytes = Buffer.from(page.base64, 'base64');
    const expectedBytes = Math.min(
      COLLECTIVE_CUSTODY_PAGE_BYTES,
      entry.manifest.totalBytes - page.index * COLLECTIVE_CUSTODY_PAGE_BYTES,
    );
    if (
      entry.role !== 'target' ||
      page.transferId !== entry.transfer.transferId ||
      page.index >= entry.manifest.pageCount ||
      bytes.byteLength !== expectedBytes ||
      bytes.toString('base64') !== page.base64 ||
      digestBytes(bytes) !== page.digest
    )
      throw new Error('Invalid Collective custody page');
    return { page, bytes };
  }
  stage(entry: CollectiveCustodyJournalEntry, unsafe: CollectiveCustodyPage) {
    const { page, bytes } = this.validatePage(entry, unsafe);
    this.withDatabase((db) => {
      const prior = this.read(db, entry.transfer);
      if (prior && (prior.entry.role !== 'target' || !isDeepStrictEqual(prior.entry.manifest, entry.manifest)))
        throw new Error('Collective target manifest changed');
      if (prior && !['target_staging', 'target_ready'].includes(prior.entry.phase))
        throw new Error('Collective target is no longer staging');
      if (!prior) {
        this.reserve(db, entry.transfer, 'target');
        db.prepare('INSERT INTO collective_artifact_transfers VALUES(?,?,?,NULL)').run(
          entry.transfer.transferId,
          entry.transfer.version.contentRef,
          JSON.stringify(entrySchema.parse(entry)),
        );
      }
      if (this.replayPage(db, page, bytes)) return;
      if (prior?.entry.phase === 'target_ready') throw new Error('Collective ready target cannot add pages');
      db.prepare('INSERT INTO collective_artifact_transfer_pages VALUES(?,?,?,?)').run(
        page.transferId,
        page.index,
        page.digest,
        bytes,
      );
    });
  }
  private replayPage(db: Database.Database, page: CollectiveCustodyPage, bytes: Buffer): boolean {
    const old = db
      .prepare('SELECT digest,bytes FROM collective_artifact_transfer_pages WHERE transfer_id=? AND page_index=?')
      .get(page.transferId, page.index) as { digest: string; bytes: Buffer } | undefined;
    if (!old) return false;
    if (old.digest !== page.digest || !old.bytes.equals(bytes)) throw new Error('Collective custody page changed');
    return true;
  }
  sourceBytes(transfer: CollectiveArtifactCustodyTransfer): Buffer {
    return this.withDatabase((db) => {
      const prior = this.read(db, transfer);
      if (!prior?.archive || prior.entry.role !== 'source') throw new Error('Collective source archive unavailable');
      this.verifyBytes(prior.entry.manifest, prior.archive);
      return prior.archive;
    });
  }
  targetBytes(transfer: CollectiveArtifactCustodyTransfer): Buffer {
    return this.withDatabase((db) => {
      const prior = this.read(db, transfer);
      if (!prior || prior.entry.role !== 'target') throw new Error('Collective target staging unavailable');
      const pages = db
        .prepare(
          'SELECT page_index,digest,bytes FROM collective_artifact_transfer_pages WHERE transfer_id=? ORDER BY page_index',
        )
        .all(transfer.transferId) as { page_index: number; digest: string; bytes: Buffer }[];
      if (pages.length !== prior.entry.manifest.pageCount) throw new Error('Collective custody page missing');
      for (const [index, page] of pages.entries())
        if (
          page.page_index !== index ||
          page.bytes.byteLength !==
            Math.min(
              COLLECTIVE_CUSTODY_PAGE_BYTES,
              prior.entry.manifest.totalBytes - index * COLLECTIVE_CUSTODY_PAGE_BYTES,
            ) ||
          digestBytes(page.bytes) !== page.digest
        )
          throw new Error('Invalid retained Collective custody page');
      const bytes = Buffer.concat(
        pages.map((page) => page.bytes),
        prior.entry.manifest.totalBytes,
      );
      this.verifyBytes(prior.entry.manifest, bytes);
      return bytes;
    });
  }
  advance(
    transfer: CollectiveArtifactCustodyTransfer,
    allowed: CollectiveCustodyJournalEntry['phase'][],
    phase: CollectiveCustodyJournalEntry['phase'],
    readyRef?: string,
  ) {
    this.withDatabase((db) => {
      const current = this.read(db, transfer)?.entry;
      if (!current) throw new Error('Collective transfer journal missing');
      if (current.phase === phase) {
        if (readyRef && current.readyRef !== readyRef) throw new Error('Collective ready receipt changed');
        return;
      }
      if (!allowed.includes(current.phase)) throw new Error('Collective transfer journal phase changed');
      db.prepare('UPDATE collective_artifact_transfers SET body=? WHERE transfer_id=?').run(
        JSON.stringify(entrySchema.parse({ ...current, phase, ...(readyRef ? { readyRef } : {}) })),
        transfer.transferId,
      );
      if (phase === 'cancelled')
        db.prepare('DELETE FROM collective_artifact_transfer_reservations WHERE content_ref=? AND transfer_id=?').run(
          transfer.version.contentRef,
          transfer.transferId,
        );
    });
  }
  private verifyBytes(manifest: CollectiveCustodyManifest, bytes: Buffer) {
    if (bytes.byteLength !== manifest.totalBytes || digestBytes(bytes) !== manifest.digest)
      throw new Error('Collective archive digest mismatch');
  }
  private reserve(db: Database.Database, transfer: CollectiveArtifactCustodyTransfer, role: 'source' | 'target') {
    const old = db
      .prepare('SELECT transfer_id FROM collective_artifact_transfer_reservations WHERE content_ref=?')
      .get(transfer.version.contentRef) as { transfer_id: string } | undefined;
    if (old && old.transfer_id !== transfer.transferId) {
      const previous = db
        .prepare('SELECT body FROM collective_artifact_transfers WHERE transfer_id=?')
        .get(old.transfer_id) as { body: string } | undefined;
      const entry = previous ? entrySchema.parse(JSON.parse(previous.body)) : null;
      if (
        role !== 'source' ||
        entry?.phase !== 'target_active' ||
        entry.transfer.targetConnectionId !== transfer.sourceConnectionId ||
        entry.transfer.expectedCustodyRevision + 1 !== transfer.expectedCustodyRevision
      )
        throw new Error('Collective transfer target reserved');
      db.prepare('UPDATE collective_artifact_transfer_reservations SET transfer_id=? WHERE content_ref=?').run(
        transfer.transferId,
        transfer.version.contentRef,
      );
      return;
    }
    db.prepare('INSERT OR IGNORE INTO collective_artifact_transfer_reservations VALUES(?,?)').run(
      transfer.version.contentRef,
      transfer.transferId,
    );
  }
  private read(db: Database.Database, transfer: CollectiveArtifactCustodyTransfer) {
    const row = db
      .prepare('SELECT body,archive FROM collective_artifact_transfers WHERE transfer_id=?')
      .get(transfer.transferId) as Row | undefined;
    if (!row) return null;
    const entry = entrySchema.parse(JSON.parse(row.body));
    if (transferIdentity(entry.transfer) !== transferIdentity(transfer))
      throw new Error('Collective transfer journal binding mismatch');
    return { entry, archive: row.archive };
  }
  private withDatabase<T>(operation: (db: Database.Database) => T): T {
    const db = new Database(this.path);
    try {
      db.pragma('journal_mode=WAL');
      db.pragma('synchronous=FULL');
      db.pragma('busy_timeout=5000');
      return db.transaction(() => operation(db)).immediate();
    } finally {
      db.close();
    }
  }
}
export function transferIdentity(transfer: CollectiveArtifactCustodyTransfer): string {
  return JSON.stringify([
    transfer.transferId,
    transfer.serviceInstanceId,
    transfer.collectiveId,
    transfer.artifactId,
    transfer.sourceEventId,
    transfer.publishedByHumanId,
    transfer.version.contentRef,
    transfer.sourceConnectionId,
    transfer.sourceEndpointId,
    transfer.sourceHumanId,
    transfer.targetConnectionId,
    transfer.targetEndpointId,
    transfer.targetHumanId,
    transfer.expectedCustodyRevision,
  ]);
}
