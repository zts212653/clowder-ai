/**
 * Host-owned pending-publication store. A PMR is an opaque plugin locator, never a message.
 * Only terminal HMR / unavailable elements cross the message-store boundary.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MessageDraft, MessageElement, PluginManifest, SendReceipt } from '@clowder-ai/plugin-contract';
import type { AppendMessageInput } from '../cats/services/stores/ports/MessageStore.js';

export const MEDIA_IMPORT_DEADLINE_MS = 120_000;

export type MediaImportResult =
  | { readonly kind: 'imported'; readonly hmrId: string }
  | { readonly kind: 'unavailable'; readonly reason: 'source_expired' | 'timeout' | 'unavailable' };

export interface MediaImportInput {
  readonly instanceId: string;
  readonly sourceEventId: string;
  readonly elementId: string;
  readonly reference: string;
  readonly sourceId: string;
  /** Stable across retries and restart; callback idempotency belongs to this element, not a send attempt. */
  readonly requestId?: string;
  readonly ingressIdentity?: string;
  readonly deadline?: number;
  readonly type: Extract<MessageElement, { kind: 'media_ref' }>['payload']['type'];
  readonly fileName?: string;
}

export interface MediaImporter {
  import(input: MediaImportInput): Promise<MediaImportResult>;
  settle?(input: MediaImportInput, outcome: 'imported' | 'unavailable'): Promise<void>;
}

export interface MediaSourceResolver {
  /** Resolve only from this installed instance's admitted manifest, then check binding against ingress identity. */
  resolve(instanceId: string, sourceId: string, ingressIdentity: string): Promise<boolean>;
}

/** Resolve the admitted source against the Host-authenticated ingress identity. */
export function mediaSourceMatchesIngress(
  manifest: PluginManifest,
  sourceId: string,
  ingressIdentity: string,
): boolean {
  const source = manifest.contributions?.find((item) => item.type === 'media-source' && item.id === sourceId);
  if (!source || source.type !== 'media-source') return false;
  const ingress = manifest.contributions?.find(
    (item) => (item.type === 'message-subscription' || item.type === 'connector') && item.id === ingressIdentity,
  );
  const identity =
    ingress?.type === 'message-subscription'
      ? ingress.binding
      : ingress?.type === 'connector'
        ? ingress.identityRef
        : ingressIdentity;
  return (
    source.binding === identity &&
    manifest.contributions?.some((item) => item.type === 'identity' && item.id === identity) === true
  );
}

export interface StagedMediaElement {
  readonly input: MediaImportInput;
  readonly result?: MediaImportResult;
  readonly settled?: boolean;
  /** Host-only callback audit; never projected to a message or a plugin. */
  readonly settleFailures?: number;
  readonly lastSettleFailureAt?: number;
}

export interface StagedMediaSend {
  readonly key: string;
  readonly instanceId: string;
  readonly sourceEventId: string;
  readonly idempotencyKey: string;
  readonly receipt: SendReceipt;
  readonly draft: MessageDraft;
  readonly appendInput: AppendMessageInput;
  readonly sender?: { readonly id: string; readonly name?: string };
  readonly media: readonly StagedMediaElement[];
  readonly createdAt: number;
  readonly deadline: number;
  readonly published: boolean;
}

export interface MediaStagingStore {
  get(key: string): Promise<StagedMediaSend | null>;
  list(): Promise<readonly StagedMediaSend[]>;
  putIfAbsent(row: StagedMediaSend): Promise<StagedMediaSend>;
  /** The update is serialized with every other mutation in the store. */
  update(key: string, update: (row: StagedMediaSend) => StagedMediaSend): Promise<StagedMediaSend | null>;
}

export function mediaStageKey(instanceId: string, sourceEventId: string, idempotencyKey: string): string {
  return [instanceId, sourceEventId, idempotencyKey].map(encodeURIComponent).join(':');
}

/** The memory implementation is a process-lifetime peer of the memory MessageStore. */
export class MemoryMediaStagingStore implements MediaStagingStore {
  private readonly rows = new Map<string, StagedMediaSend>();

  async get(key: string): Promise<StagedMediaSend | null> {
    const row = this.rows.get(key);
    return row ? structuredClone(row) : null;
  }

  async list(): Promise<readonly StagedMediaSend[]> {
    return [...this.rows.values()].map((row) => structuredClone(row));
  }

  async putIfAbsent(row: StagedMediaSend): Promise<StagedMediaSend> {
    const winner = this.rows.get(row.key);
    if (winner) return structuredClone(winner);
    this.rows.set(row.key, structuredClone(row));
    return structuredClone(row);
  }

  async update(key: string, update: (row: StagedMediaSend) => StagedMediaSend): Promise<StagedMediaSend | null> {
    const old = this.rows.get(key);
    if (!old) return null;
    const next = update(structuredClone(old));
    this.rows.set(key, structuredClone(next));
    return structuredClone(next);
  }
}

/** Durable single-Host snapshot. Mutations are serialized and replaced atomically. */
export class FileMediaStagingStore implements MediaStagingStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async readRows(): Promise<Map<string, StagedMediaSend>> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('media staging ledger is corrupt');
    const rows = new Map<string, StagedMediaSend>();
    for (const candidate of parsed) {
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        typeof candidate.key !== 'string' ||
        !candidate.receipt ||
        typeof candidate.receipt.messageId !== 'string' ||
        !Array.isArray(candidate.media) ||
        typeof candidate.createdAt !== 'number' ||
        typeof candidate.deadline !== 'number' ||
        typeof candidate.published !== 'boolean' ||
        rows.has(candidate.key)
      ) {
        throw new Error('media staging ledger is corrupt');
      }
      rows.set(candidate.key, candidate as StagedMediaSend);
    }
    return rows;
  }

  private async save(rows: Map<string, StagedMediaSend>): Promise<void> {
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

  get(key: string): Promise<StagedMediaSend | null> {
    return this.serialize(async () => (await this.readRows()).get(key) ?? null);
  }

  list(): Promise<readonly StagedMediaSend[]> {
    return this.serialize(async () => [...(await this.readRows()).values()]);
  }

  putIfAbsent(row: StagedMediaSend): Promise<StagedMediaSend> {
    return this.serialize(async () => {
      const rows = await this.readRows();
      const winner = rows.get(row.key);
      if (winner) return winner;
      rows.set(row.key, row);
      await this.save(rows);
      return row;
    });
  }

  update(key: string, update: (row: StagedMediaSend) => StagedMediaSend): Promise<StagedMediaSend | null> {
    return this.serialize(async () => {
      const rows = await this.readRows();
      const old = rows.get(key);
      if (!old) return null;
      const next = update(old);
      rows.set(key, next);
      await this.save(rows);
      return next;
    });
  }
}
