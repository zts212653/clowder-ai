import { channel } from 'node:diagnostics_channel';
import type Database from 'better-sqlite3';
import { runMemoryCheckpoint } from './MemoryProcess.js';
import type { WalCheckpointResult } from './memory-process-protocol.js';

const active = new WeakMap<Database.Database, ProjectionCheckpoints>();
const CHECKPOINT_PAGES = 1000;
const MAX_BACKLOG_BYTES = 64 * 1024 * 1024;

export class ProjectionCheckpointBackpressureError extends Error {
  readonly retryable = true;
  constructor(readonly checkpoint: WalCheckpointResult) {
    super('Memory projection checkpoint made insufficient progress; retry when readers release their snapshots');
    this.name = 'ProjectionCheckpointBackpressureError';
  }
}

/** One lease per API connection; SqliteEvidenceStore's writer queue owns it.
 * Bounded batches await maintenance instead of making the next ledger commit
 * checkpoint their pages. NORMAL and other connections' settings are unchanged. */
export class ProjectionCheckpoints {
  published = false;
  private readonly automatic: number;
  private readonly pageSize: number;
  private released = false;

  constructor(
    private readonly db: Database.Database,
    private readonly dbPath: string,
    private readonly runCheckpoint = runMemoryCheckpoint,
  ) {
    if (active.has(db)) throw new Error('Memory projection checkpoint scope already owns this connection');
    if (db.inTransaction) throw new Error('Memory projection checkpoint scope cannot own an open transaction');
    this.automatic = db.pragma('wal_autocheckpoint', { simple: true }) as number;
    this.pageSize = db.pragma('page_size', { simple: true }) as number;
    db.pragma('wal_autocheckpoint = 0');
    active.set(db, this);
  }

  async afterBatch(): Promise<void> {
    const [state] = this.db.pragma('main.wal_checkpoint(NOOP)') as WalCheckpointResult[];
    if (!state) throw new Error('SQLite did not report WAL backlog');
    if (state.busy || state.log - state.checkpointed >= CHECKPOINT_PAGES) {
      const result = await this.checkpoint();
      if (result.busy || (result.log - result.checkpointed) * this.pageSize > MAX_BACKLOG_BYTES) {
        throw new ProjectionCheckpointBackpressureError(result);
      }
    }
  }

  async drain(): Promise<void> {
    if (this.released) return;
    const result = await this.checkpoint();
    if (result.busy || result.log !== result.checkpointed) throw new ProjectionCheckpointBackpressureError(result);
  }

  restore(): void {
    if (this.released) return;
    try {
      this.db.pragma(`wal_autocheckpoint = ${this.automatic}`);
      this.released = true;
    } finally {
      // Failed restoration on a usable connection retains this owner and its
      // saved policy. The outer finalizer can retry once; persistent failure
      // fences later publishers until the store closes/reopens the connection.
      if (this.released || !this.db.open) {
        this.released = true;
        active.delete(this.db);
      }
    }
  }

  private async checkpoint(): Promise<WalCheckpointResult> {
    const started = performance.now();
    const result = await this.runCheckpoint(this.dbPath);
    channel('cat-cafe.entity-mention-checkpoint').publish({ ...result, durationMs: performance.now() - started });
    return result;
  }
}

export async function withProjectionCheckpoints(
  db: Database.Database,
  dbPath: string,
  operation: (checkpoints: ProjectionCheckpoints) => Promise<void>,
): Promise<void> {
  const checkpoints = new ProjectionCheckpoints(db, dbPath);
  let failed = false;
  try {
    return await operation(checkpoints);
  } catch (error) {
    failed = true;
    if (!checkpoints.published) throw error;
    console.warn('[memory] Committed projection cleanup deferred', error);
  } finally {
    try {
      await checkpoints.drain();
    } catch (error) {
      // Maintenance must not mask a source conflict or revoke committed approval.
      if (failed || checkpoints.published) console.warn('[memory] Projection checkpoint deferred', error);
      else {
        failed = true;
        throw error;
      }
    } finally {
      try {
        checkpoints.restore();
      } catch (error) {
        if (failed || checkpoints.published) console.warn('[memory] Checkpoint setting restoration failed', error);
        else throw error;
      }
    }
  }
}
