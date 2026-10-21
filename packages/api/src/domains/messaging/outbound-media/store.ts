/**
 * F202 W2-5b — durable record of Host messages whose publication waits on media materialization.
 *
 * A Host message that carries audio / file / gallery blocks is written to the message store at
 * once (the Hub never waits) but reaches the plugin stream only after its media has become Host
 * media references. This store is the job's truth: which messages are still pending, the final
 * media elements once they exist, and whether the one `message.publish` has happened.
 *
 * The final elements live here rather than in the message's `extra`: extra writes are
 * read-merge-write in the Redis store, and stream-metadata augmentation writes the same message
 * right after a cat reply lands — exactly while materialization runs. Keeping the result out of
 * the message means neither writer can erase the other's work.
 *
 * Published rows stay: the catch-up snapshot projects a deferred message from them after its
 * event has been trimmed. Same single-file shape as the inbound staging store (e1a); the same
 * scale note applies (whole-file rewrite per mutation).
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MessageElement } from '@clowder-ai/plugin-contract';

export type OutboundMediaState = 'pending' | 'publishing' | 'published';

export interface OutboundMediaRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly createdAt: number;
  readonly state: OutboundMediaState;
  /** Media elements in block order, fixed before the publish event is written. */
  readonly elements?: readonly MessageElement[];
  readonly publishedSequence?: number;
}

export interface OutboundMediaStore {
  get(messageId: string): Promise<OutboundMediaRow | null>;
  list(): Promise<readonly OutboundMediaRow[]>;
  putIfAbsent(row: OutboundMediaRow): Promise<OutboundMediaRow>;
  /** Serialized with every other mutation of the store. */
  update(messageId: string, update: (row: OutboundMediaRow) => OutboundMediaRow): Promise<OutboundMediaRow | null>;
}

export class MemoryOutboundMediaStore implements OutboundMediaStore {
  private readonly rows = new Map<string, OutboundMediaRow>();

  async get(messageId: string): Promise<OutboundMediaRow | null> {
    const row = this.rows.get(messageId);
    return row ? structuredClone(row) : null;
  }

  async list(): Promise<readonly OutboundMediaRow[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }

  async putIfAbsent(row: OutboundMediaRow): Promise<OutboundMediaRow> {
    const winner = this.rows.get(row.messageId);
    if (winner) return structuredClone(winner);
    this.rows.set(row.messageId, structuredClone(row));
    return structuredClone(row);
  }

  async update(
    messageId: string,
    update: (row: OutboundMediaRow) => OutboundMediaRow,
  ): Promise<OutboundMediaRow | null> {
    const old = this.rows.get(messageId);
    if (!old) return null;
    const next = update(structuredClone(old));
    this.rows.set(messageId, structuredClone(next));
    return structuredClone(next);
  }
}

const STATES = new Set<OutboundMediaState>(['pending', 'publishing', 'published']);

function isRow(value: unknown): value is OutboundMediaRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.messageId === 'string' &&
    typeof row.threadId === 'string' &&
    typeof row.createdAt === 'number' &&
    STATES.has(row.state as OutboundMediaState) &&
    (row.elements === undefined || Array.isArray(row.elements)) &&
    (row.publishedSequence === undefined || typeof row.publishedSequence === 'number')
  );
}

/** Durable single-Host store. Mutations are serialized and each one replaces the file atomically. */
export class FileOutboundMediaStore implements OutboundMediaStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async readRows(): Promise<Map<string, OutboundMediaRow>> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('outbound media store is corrupt');
    const rows = new Map<string, OutboundMediaRow>();
    for (const candidate of parsed) {
      if (!isRow(candidate) || rows.has(candidate.messageId)) throw new Error('outbound media store is corrupt');
      rows.set(candidate.messageId, candidate);
    }
    return rows;
  }

  private async save(rows: Map<string, OutboundMediaRow>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify([...rows.values()]));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, this.path);
    if (process.platform !== 'win32') {
      const directory = await open(dirname(this.path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  }

  private async serialize<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  get(messageId: string): Promise<OutboundMediaRow | null> {
    return this.serialize(async () => (await this.readRows()).get(messageId) ?? null);
  }

  list(): Promise<readonly OutboundMediaRow[]> {
    return this.serialize(async () => [...(await this.readRows()).values()]);
  }

  putIfAbsent(row: OutboundMediaRow): Promise<OutboundMediaRow> {
    return this.serialize(async () => {
      const rows = await this.readRows();
      const winner = rows.get(row.messageId);
      if (winner) return winner;
      rows.set(row.messageId, row);
      await this.save(rows);
      return row;
    });
  }

  update(messageId: string, update: (row: OutboundMediaRow) => OutboundMediaRow): Promise<OutboundMediaRow | null> {
    return this.serialize(async () => {
      const rows = await this.readRows();
      const old = rows.get(messageId);
      if (!old) return null;
      const next = update(old);
      rows.set(messageId, next);
      await this.save(rows);
      return next;
    });
  }
}
