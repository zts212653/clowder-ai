import { randomUUID } from 'node:crypto';
import type { MatterMutationReceipt, MatterSourceCoordinate, MatterWriteInput, MemoryMatter } from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import { MatterMemoryError, matterDigest } from './matter-source.js';

export interface StoredMatter extends MemoryMatter {
  ownerUserId: string;
}
export interface StoredMatterEntry {
  entryId: string;
  source: MatterSourceCoordinate;
  status: 'active' | 'superseded' | 'retired';
  supersededBy?: string;
}
interface MatterRow {
  matter_id: string;
  owner_user_id: string;
  title: string;
  description: string;
  revision: number;
  status: 'active' | 'retired';
  created_at: number;
  updated_at: number;
}
interface EntryRow {
  entry_id: string;
  source_json: string;
  status: StoredMatterEntry['status'];
  superseded_by: string | null;
}
interface RequestRow {
  fingerprint: string;
  matter_id: string;
  result_json: string;
}
function fromRow(row: MatterRow): StoredMatter {
  return {
    matterId: row.matter_id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    description: row.description,
    revision: row.revision,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Only this store writes canonical matter facts; the service supplies current source admission. */
export class MatterMemoryStore {
  constructor(private readonly db: Database.Database) {}

  get(ownerUserId: string, matterId: string): StoredMatter | null {
    const row = this.db
      .prepare('SELECT * FROM memory_matters WHERE owner_user_id = ? AND matter_id = ?')
      .get(ownerUserId, matterId) as MatterRow | undefined;
    return row ? fromRow(row) : null;
  }
  list(ownerUserId: string, includeRetired = false): StoredMatter[] {
    return (
      this.db
        .prepare(`SELECT * FROM memory_matters WHERE owner_user_id = ?
      ${includeRetired ? '' : "AND status = 'active'"} ORDER BY updated_at DESC, matter_id`)
        .all(ownerUserId) as MatterRow[]
    ).map(fromRow);
  }
  entries(matterId: string): StoredMatterEntry[] {
    return (
      this.db
        .prepare('SELECT * FROM memory_matter_entries WHERE matter_id = ? ORDER BY entry_id')
        .all(matterId) as EntryRow[]
    ).map((row) => ({
      entryId: row.entry_id,
      source: JSON.parse(row.source_json) as MatterSourceCoordinate,
      status: row.status,
      ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
    }));
  }
  retry(ownerUserId: string, actorKey: string, input: MatterWriteInput): MatterMutationReceipt | null {
    const row = this.db
      .prepare('SELECT * FROM memory_matter_requests WHERE owner_user_id = ? AND actor_key = ? AND request_id = ?')
      .get(ownerUserId, actorKey, input.requestId) as RequestRow | undefined;
    if (!row) return null;
    if (row.fingerprint !== matterDigest(input)) throw new MatterMemoryError('request_conflict');
    const receipt = JSON.parse(row.result_json) as MatterMutationReceipt;
    if (this.forgotten(ownerUserId, row.matter_id)) return { ...receipt, outcome: 'forgotten' };
    return receipt;
  }
  private forgotten(ownerUserId: string, matterId: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM memory_matter_forget_fences WHERE owner_user_id = ? AND matter_id = ?')
        .get(ownerUserId, matterId),
    );
  }

  write(
    ownerUserId: string,
    actorKey: string,
    input: MatterWriteInput,
    sources: MatterSourceCoordinate[],
  ): MatterMutationReceipt {
    return this.db
      .transaction(() => {
        const retry = this.retry(ownerUserId, actorKey, input);
        if (retry) return retry;
        const now = Date.now();
        const matter =
          input.operation === 'create'
            ? this.createMatter(ownerUserId, input, sources, now)
            : this.applyExistingChange(ownerUserId, input, sources, now);
        const receipt: MatterMutationReceipt = {
          outcome: input.operation === 'forget' ? 'forgotten' : 'applied',
          matter: { matterId: matter.matterId, revision: matter.revision, status: matter.status },
        };
        this.db
          .prepare('INSERT INTO memory_matter_requests VALUES (?, ?, ?, ?, ?, ?)')
          .run(ownerUserId, actorKey, input.requestId, matterDigest(input), matter.matterId, JSON.stringify(receipt));
        return receipt;
      })
      .immediate();
  }

  private createMatter(
    ownerUserId: string,
    input: Extract<MatterWriteInput, { operation: 'create' }>,
    sources: MatterSourceCoordinate[],
    now: number,
  ): StoredMatter {
    const matter: StoredMatter = {
      matterId: `matter_${randomUUID()}`,
      ownerUserId,
      title: input.title,
      description: input.description,
      revision: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO memory_matters VALUES (@matterId, @ownerUserId, @title, @description,
      @revision, @status, @createdAt, @updatedAt)`)
      .run(matter);
    for (const source of sources) this.addEntry(matter.matterId, source, now);
    return matter;
  }

  private applyExistingChange(
    ownerUserId: string,
    input: Exclude<MatterWriteInput, { operation: 'create' }>,
    sources: MatterSourceCoordinate[],
    now: number,
  ): StoredMatter {
    const current = this.get(ownerUserId, input.matterId);
    if (!current) throw new MatterMemoryError('not_available');
    if (current.revision !== input.expectedRevision) throw new MatterMemoryError('stale_revision');
    const matter = { ...current, revision: current.revision + 1, updatedAt: now };
    switch (input.operation) {
      case 'forget':
        this.db
          .prepare('INSERT INTO memory_matter_forget_fences VALUES (?, ?, ?)')
          .run(ownerUserId, matter.matterId, now);
        this.db.prepare('DELETE FROM memory_matter_entries WHERE matter_id = ?').run(matter.matterId);
        this.db
          .prepare('DELETE FROM memory_matters WHERE matter_id = ? AND owner_user_id = ?')
          .run(matter.matterId, ownerUserId);
        return matter;
      case 'edit':
        matter.title = input.title;
        matter.description = input.description;
        break;
      case 'retire':
        matter.status = 'retired';
        break;
      case 'append':
        for (const source of sources) this.addEntry(matter.matterId, source, now);
        break;
      case 'correct':
      case 'retire_entry':
        this.replaceOrRetireEntry(matter.matterId, input, sources[0], now);
        break;
    }
    this.db
      .prepare(`UPDATE memory_matters SET title = @title, description = @description, revision = @revision,
      status = @status, updated_at = @updatedAt WHERE matter_id = @matterId AND owner_user_id = @ownerUserId`)
      .run(matter);
    return matter;
  }

  private replaceOrRetireEntry(
    matterId: string,
    input: Extract<MatterWriteInput, { operation: 'correct' | 'retire_entry' }>,
    source: MatterSourceCoordinate | undefined,
    now: number,
  ): void {
    const entry = this.entries(matterId).find(
      (candidate) => candidate.entryId === input.entryId && candidate.status === 'active',
    );
    if (!entry) throw new MatterMemoryError('not_available');
    let replacement: string | null = null;
    if (input.operation === 'correct') {
      if (!source) throw new MatterMemoryError('invalid_source');
      replacement = this.addEntry(matterId, source, now);
      if (replacement === entry.entryId) throw new MatterMemoryError('invalid_source');
    }
    this.db
      .prepare('UPDATE memory_matter_entries SET status = ?, superseded_by = ? WHERE entry_id = ? AND matter_id = ?')
      .run(replacement ? 'superseded' : 'retired', replacement, entry.entryId, matterId);
  }

  private addEntry(matterId: string, source: MatterSourceCoordinate, now: number): string {
    const key = matterDigest(source);
    const existing = this.db
      .prepare('SELECT entry_id, status FROM memory_matter_entries WHERE matter_id = ? AND source_key = ?')
      .get(matterId, key) as { entry_id: string; status: string } | undefined;
    if (existing) {
      if (existing.status !== 'active') throw new MatterMemoryError('invalid_source');
      return existing.entry_id;
    }
    const entryId = `entry_${randomUUID()}`;
    this.db
      .prepare("INSERT INTO memory_matter_entries VALUES (?, ?, ?, ?, 'active', NULL, ?)")
      .run(entryId, matterId, key, JSON.stringify(source), now);
    return entryId;
  }
}
