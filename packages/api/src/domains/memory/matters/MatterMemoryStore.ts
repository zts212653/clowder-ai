import { randomUUID } from 'node:crypto';
import type {
  MatterMutationReceipt,
  MatterPage,
  MatterSourceReference,
  MatterWriteInput,
  MatterWriteRef,
  MatterWriteSnapshot,
  MessageFrom,
} from '@cat-cafe/shared';
import type Database from 'better-sqlite3';
import type { MatterAccessGuard } from './matter-access.js';
import { MatterMemoryError, matterDigest } from './matter-source.js';
import {
  type EntryRow,
  fromRow,
  type MatterRow,
  type RequestRow,
  type StoredMatter,
  type StoredMatterEntry,
  type StoredWriteReceipt,
} from './matter-store-records.js';
import { type MatterWriteContent, normalizeMatterWriteContent } from './matter-write-content.js';
import { matterWriteSnapshot } from './matter-write-snapshot.js';

export type { StoredMatter, StoredMatterEntry } from './matter-store-records.js';

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
      source: JSON.parse(row.source_json) as MatterSourceReference,
      ...(row.summary !== null ? { summary: row.summary } : {}),
      ...(row.summary_author_json ? { summaryAuthor: JSON.parse(row.summary_author_json) as MessageFrom } : {}),
      recordedAt: row.created_at,
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
    const { snapshot: _privateSnapshot, ...receipt } = JSON.parse(row.result_json) as StoredWriteReceipt;
    if (this.forgotten(ownerUserId, row.matter_id)) return { ...receipt, outcome: 'forgotten' };
    return receipt;
  }
  writeSnapshot(
    ownerUserId: string,
    matterId: string,
    ref: Pick<MatterWriteRef, 'actorKey' | 'requestId'>,
  ): MatterWriteSnapshot | null {
    const row = this.db
      .prepare(
        'SELECT * FROM memory_matter_requests WHERE owner_user_id = ? AND actor_key = ? AND request_id = ? AND matter_id = ?',
      )
      .get(ownerUserId, ref.actorKey, ref.requestId, matterId) as RequestRow | undefined;
    return row ? ((JSON.parse(row.result_json) as StoredWriteReceipt).snapshot ?? null) : null;
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
    sources: MatterSourceReference[],
    content: MatterWriteContent = normalizeMatterWriteContent(input),
    writer?: MessageFrom,
    accessGuard?: MatterAccessGuard,
    before?: MatterPage,
  ): MatterMutationReceipt {
    return this.db
      .transaction(() => {
        const retry = this.retry(ownerUserId, actorKey, input);
        if (retry) return retry;
        const now = Date.now();
        const matter =
          input.operation === 'create'
            ? this.createMatter(ownerUserId, input, sources, now, content, writer, accessGuard)
            : this.applyExistingChange(ownerUserId, input, sources, now, content.summary, writer, accessGuard);
        const receipt: MatterMutationReceipt = {
          outcome: input.operation === 'forget' ? 'forgotten' : 'applied',
          matter: { matterId: matter.matterId, revision: matter.revision, status: matter.status },
          writeRef: { actorKey, requestId: input.requestId, operation: input.operation, revision: matter.revision },
        };
        const stored: StoredWriteReceipt =
          input.operation === 'forget'
            ? receipt
            : {
                ...receipt,
                snapshot: matterWriteSnapshot(input, matter, this.entries(matter.matterId), sources, before, writer),
              };
        this.db
          .prepare('INSERT INTO memory_matter_requests VALUES (?, ?, ?, ?, ?, ?)')
          .run(ownerUserId, actorKey, input.requestId, matterDigest(input), matter.matterId, JSON.stringify(stored));
        return receipt;
      })
      .immediate();
  }

  private createMatter(
    ownerUserId: string,
    input: Extract<MatterWriteInput, { operation: 'create' }>,
    sources: MatterSourceReference[],
    now: number,
    content: MatterWriteContent,
    writer?: MessageFrom,
    accessGuard?: MatterAccessGuard,
  ): StoredMatter {
    const description = content.initialDescription;
    const matter: StoredMatter = {
      matterId: `matter_${randomUUID()}`,
      ownerUserId,
      accessGuards: accessGuard ? [accessGuard] : [],
      title: input.title,
      description,
      ...(description && writer ? { descriptionAuthor: writer } : {}),
      revision: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(`INSERT INTO memory_matters (matter_id, owner_user_id, title, description, revision, status, created_at, updated_at, description_author_json, access_guards_json)
      VALUES (@matterId, @ownerUserId, @title, @description, @revision, @status, @createdAt, @updatedAt, @descriptionAuthorJson, @accessGuardsJson)`)
      .run({
        ...matter,
        descriptionAuthorJson: matter.descriptionAuthor ? JSON.stringify(matter.descriptionAuthor) : null,
        accessGuardsJson: JSON.stringify(matter.accessGuards),
      });
    const entryIds = sources.map((source) => this.addEntry(matter.matterId, source, now, content.summary, writer));
    // Only the actual seed entry owns the implicit page context. Equal text creates no relationship.
    if (content.descriptionFromEntry && entryIds[0]) {
      matter.descriptionEntryId = entryIds[0];
      this.db
        .prepare('UPDATE memory_matters SET description_entry_id = ? WHERE matter_id = ?')
        .run(matter.descriptionEntryId, matter.matterId);
    }
    return matter;
  }

  private applyExistingChange(
    ownerUserId: string,
    input: Exclude<MatterWriteInput, { operation: 'create' }>,
    sources: MatterSourceReference[],
    now: number,
    summary?: string,
    writer?: MessageFrom,
    accessGuard?: MatterAccessGuard,
  ): StoredMatter {
    const current = this.get(ownerUserId, input.matterId);
    if (!current) throw new MatterMemoryError('not_available');
    if (current.revision !== input.expectedRevision) throw new MatterMemoryError('stale_revision');
    const matter = { ...current, revision: current.revision + 1, updatedAt: now };
    if (
      accessGuard &&
      !matter.accessGuards.some(
        (guard) => guard.threadId === accessGuard.threadId && guard.messageId === accessGuard.messageId,
      )
    )
      matter.accessGuards = [...matter.accessGuards, accessGuard];
    switch (input.operation) {
      case 'forget':
        this.db
          .prepare(
            "UPDATE memory_matter_requests SET result_json = json_remove(result_json, '$.snapshot') WHERE owner_user_id = ? AND matter_id = ?",
          )
          .run(ownerUserId, matter.matterId);
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
        if (matter.description !== input.description) {
          matter.description = input.description;
          matter.descriptionAuthor = writer;
          matter.descriptionEntryId = undefined;
        }
        break;
      case 'retire':
        matter.status = 'retired';
        break;
      case 'append':
        for (const source of sources) this.addEntry(matter.matterId, source, now, summary, writer);
        break;
      case 'correct':
      case 'retire_entry': {
        const previous = this.replaceOrRetireEntry(matter.matterId, input, sources[0], now, summary, writer);
        if (matter.descriptionEntryId === previous.entryId) {
          if (input.operation === 'retire_entry' || summary !== previous.summary) {
            const description = input.operation === 'correct' ? (summary ?? '') : '';
            if (description !== matter.description) {
              matter.description = description;
              matter.descriptionAuthor = description ? writer : undefined;
            }
          }
          matter.descriptionEntryId = matter.description ? previous.supersededBy : undefined;
        }
        break;
      }
    }
    this.db
      .prepare(`UPDATE memory_matters SET title = @title, description = @description, revision = @revision,
      status = @status, updated_at = @updatedAt, description_author_json = @descriptionAuthorJson,
      description_entry_id = @descriptionEntryId, access_guards_json = @accessGuardsJson
      WHERE matter_id = @matterId AND owner_user_id = @ownerUserId`)
      .run({
        ...matter,
        descriptionAuthorJson: matter.descriptionAuthor ? JSON.stringify(matter.descriptionAuthor) : null,
        descriptionEntryId: matter.descriptionEntryId ?? null,
        accessGuardsJson: JSON.stringify(matter.accessGuards),
      });
    return matter;
  }

  private replaceOrRetireEntry(
    matterId: string,
    input: Extract<MatterWriteInput, { operation: 'correct' | 'retire_entry' }>,
    source: MatterSourceReference | undefined,
    now: number,
    summary?: string,
    writer?: MessageFrom,
  ): StoredMatterEntry {
    const entry = this.entries(matterId).find(
      (candidate) => candidate.entryId === input.entryId && candidate.status === 'active',
    );
    if (!entry) throw new MatterMemoryError('not_available');
    let replacement: string | null = null;
    if (input.operation === 'correct') {
      if (!source) throw new MatterMemoryError('invalid_source');
      const summaryAuthor = summary === entry.summary ? entry.summaryAuthor : writer;
      replacement = this.addEntry(matterId, source, now, summary, summaryAuthor);
      if (replacement === entry.entryId)
        throw new MatterMemoryError('invalid_source', {
          reason: 'unchanged_entry',
          hint: 'The summary and return address are unchanged. Keep the current entry, or change the content or source you intended to correct; no quotation selection is required.',
        });
    }
    this.db
      .prepare(
        "UPDATE memory_matter_entries SET status = ?, superseded_by = ?, source_key = 'history:' || entry_id WHERE entry_id = ? AND matter_id = ?",
      )
      .run(replacement ? 'superseded' : 'retired', replacement, entry.entryId, matterId);
    return { ...entry, ...(replacement ? { supersededBy: replacement } : {}) };
  }

  private addEntry(
    matterId: string,
    source: MatterSourceReference,
    now: number,
    summary?: string,
    summaryAuthor?: MessageFrom,
  ): string {
    const key = matterDigest(summary ? { source, summary, writer: summaryAuthor } : source);
    const existing = this.db
      .prepare('SELECT entry_id, status FROM memory_matter_entries WHERE matter_id = ? AND source_key = ?')
      .get(matterId, key) as { entry_id: string; status: string } | undefined;
    if (existing?.status === 'active') return existing.entry_id;
    // Old-format inactive rows may still hold their content key. Preserve the occurrence, releasing
    // only its private dedup key so this newly admitted write can create an independent entry.
    if (existing)
      this.db
        .prepare(
          "UPDATE memory_matter_entries SET source_key = 'history:' || entry_id WHERE entry_id = ? AND matter_id = ?",
        )
        .run(existing.entry_id, matterId);
    const entryId = `entry_${randomUUID()}`;
    this.db
      .prepare(`INSERT INTO memory_matter_entries (entry_id, matter_id, source_key, source_json, status, superseded_by, created_at, summary, summary_author_json)
        VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, ?)`)
      .run(
        entryId,
        matterId,
        key,
        JSON.stringify(source),
        now,
        summary ?? null,
        summary && summaryAuthor ? JSON.stringify(summaryAuthor) : null,
      );
    return entryId;
  }
}
