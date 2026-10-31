import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { WorkspaceContentLocatorV1 } from '../workspace-content-source-contract.js';

export const digestWritebackBytes = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function workspaceWritebackReceiptRef(ownerUserId: string, acceptOperationId: string): string {
  return `workspace-writeback:${createHash('sha256')
    .update(JSON.stringify([ownerUserId, acceptOperationId]))
    .digest('hex')}`;
}

export interface WorkspaceWritebackInput {
  acceptOperationId: string;
  requestId: string;
  candidateRef: string;
  locator: WorkspaceContentLocatorV1;
  baseRevision: string;
  /** Supplied only by the server's authenticated candidate owner, never by the browser. */
  bytes: Buffer;
}

export interface WritebackRecord {
  receiptRef: string;
  ownerUserId: string;
  fingerprint: string;
  locator: WorkspaceContentLocatorV1;
  targetPath: string;
  baseRevision: string;
  candidateRevision: string;
  requestId: string;
  candidateRef: string;
  acceptOperationId: string;
  state: 'intent' | 'prepared' | 'applied' | 'conflict' | 'unknown';
  proof?: { path: string; temporaryPath: string; dev: string; ino: string };
  /** Digest written by this operation; it does not describe the file's current bytes. */
  writtenRevision?: string;
  appliedAt?: number;
  /** Durable F063 receipt order; wall-clock ties must not guess the latest applied base. */
  appliedSequence?: number;
}

export class WorkspaceWritebackError extends Error {
  constructor(
    readonly code:
      | 'operation_reused'
      | 'identity_required'
      | 'edit_token_invalid'
      | 'access_denied'
      | 'too_large'
      | 'proof_unavailable',
  ) {
    super(code);
  }
}

export class WorkspaceWritebackJournal {
  private readonly db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.exec('CREATE TABLE IF NOT EXISTS workspace_writebacks (receipt_ref TEXT PRIMARY KEY, body TEXT NOT NULL)');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS workspace_writeback_clock (id INTEGER PRIMARY KEY CHECK(id=1), value INTEGER NOT NULL); INSERT OR IGNORE INTO workspace_writeback_clock VALUES(1,0)',
    );
  }
  close(): void {
    this.db.close();
  }

  get(receiptRef: string): WritebackRecord | undefined {
    const row = this.db.prepare('SELECT body FROM workspace_writebacks WHERE receipt_ref = ?').get(receiptRef) as
      | { body: string }
      | undefined;
    if (!row) return undefined;
    const { newRevision, ...record } = JSON.parse(row.body) as WritebackRecord & { newRevision?: string };
    // Keep already persisted checkpoint receipts readable without changing their event meaning.
    return {
      ...record,
      ...(record.writtenRevision || newRevision ? { writtenRevision: record.writtenRevision ?? newRevision } : {}),
    };
  }

  reserve(input: WorkspaceWritebackInput, ownerUserId: string, targetPath: string): WritebackRecord {
    const candidateRevision = digestWritebackBytes(input.bytes);
    const receiptRef = workspaceWritebackReceiptRef(ownerUserId, input.acceptOperationId);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          input.requestId,
          input.candidateRef,
          input.locator.worktreeId,
          input.locator.path,
          targetPath,
          input.baseRevision,
          candidateRevision,
        ]),
      )
      .digest('hex');
    return this.db.transaction(() => {
      const existing = this.get(receiptRef);
      if (existing) {
        if (existing.ownerUserId !== ownerUserId || existing.fingerprint !== fingerprint)
          throw new WorkspaceWritebackError('operation_reused');
        return existing;
      }
      const record: WritebackRecord = {
        receiptRef,
        ownerUserId,
        fingerprint,
        targetPath,
        locator: input.locator,
        candidateRevision,
        baseRevision: input.baseRevision,
        requestId: input.requestId,
        candidateRef: input.candidateRef,
        acceptOperationId: input.acceptOperationId,
        state: 'intent',
      };
      this.db.prepare('INSERT INTO workspace_writebacks VALUES (?, ?)').run(receiptRef, JSON.stringify(record));
      return record;
    })();
  }

  save(record: WritebackRecord): WritebackRecord {
    return this.db
      .transaction(() => {
        if (record.state === 'applied' && record.appliedSequence === undefined) {
          const prior = this.get(record.receiptRef);
          const sequence =
            prior?.appliedSequence ??
            (
              this.db
                .prepare('UPDATE workspace_writeback_clock SET value=value+1 WHERE id=1 RETURNING value')
                .get() as { value: number }
            ).value;
          record = { ...record, appliedSequence: sequence };
        }
        this.db
          .prepare('UPDATE workspace_writebacks SET body = ? WHERE receipt_ref = ?')
          .run(JSON.stringify(record), record.receiptRef);
        return record;
      })
      .immediate();
  }
}
