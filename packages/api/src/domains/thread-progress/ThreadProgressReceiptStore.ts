import type { ThreadProgressReceiptV1 } from '@cat-cafe/shared';

export interface AppendThreadProgressReceiptResult {
  readonly receipt: ThreadProgressReceiptV1;
  readonly inserted: boolean;
}

export interface ThreadProgressRecentThread {
  readonly threadId: string;
  readonly lastProgressAt: number;
}

export interface ListRecentThreadOptions {
  readonly limit?: number;
  readonly cursor?: string;
  readonly excludeThreadIds?: ReadonlySet<string>;
}

export class InvalidThreadProgressCursorError extends Error {}

export interface IThreadProgressReceiptStore {
  appendIfAbsent(
    receipt: ThreadProgressReceiptV1,
    options?: { readonly terminalTurnKey?: string },
  ): Promise<AppendThreadProgressReceiptResult>;
  get(receiptId: string): Promise<ThreadProgressReceiptV1 | null>;
  listByThread(
    ownerUserId: string,
    threadId: string,
    options?: { readonly limit?: number },
  ): Promise<ThreadProgressReceiptV1[]>;
  listPageByThread(
    ownerUserId: string,
    threadId: string,
    options?: { readonly limit?: number; readonly cursor?: string },
  ): Promise<{ readonly items: ThreadProgressReceiptV1[]; readonly nextCursor: string | null }>;
  listRecentThreads(
    ownerUserId: string,
    options?: ListRecentThreadOptions,
  ): Promise<{ readonly items: ThreadProgressRecentThread[]; readonly nextCursor: string | null }>;
}

/** In-memory implementation used only by explicit memory mode and isolated tests. */
export class ThreadProgressReceiptStore implements IThreadProgressReceiptStore {
  private readonly receipts = new Map<string, ThreadProgressReceiptV1>();
  private readonly sourceIndex = new Map<string, string>();
  private readonly terminalTurnIndex = new Map<string, string>();
  private readonly threadIndex = new Map<string, string[]>();
  private readonly recentThreadsByOwner = new Map<string, Map<string, number>>();

  async appendIfAbsent(
    receipt: ThreadProgressReceiptV1,
    options: { readonly terminalTurnKey?: string } = {},
  ): Promise<AppendThreadProgressReceiptResult> {
    const sourceExistingId = this.sourceIndex.get(receipt.sourceKey);
    const turnExistingId = options.terminalTurnKey ? this.terminalTurnIndex.get(options.terminalTurnKey) : undefined;
    const existingId = turnExistingId ?? sourceExistingId;
    if (existingId) {
      if (options.terminalTurnKey && !turnExistingId && sourceExistingId) {
        this.terminalTurnIndex.set(options.terminalTurnKey, sourceExistingId);
      }
      const existing = this.receipts.get(existingId);
      if (!existing) throw new Error(`Thread progress source index points to missing receipt: ${existingId}`);
      return { receipt: existing, inserted: false };
    }

    this.receipts.set(receipt.id, receipt);
    this.sourceIndex.set(receipt.sourceKey, receipt.id);
    if (options.terminalTurnKey) this.terminalTurnIndex.set(options.terminalTurnKey, receipt.id);
    const key = threadIndexKey(receipt.ownerUserId, receipt.threadId);
    const ids = this.threadIndex.get(key) ?? [];
    ids.push(receipt.id);
    ids.sort((left, right) => compareReceipts(this.requiredReceipt(left), this.requiredReceipt(right)));
    this.threadIndex.set(key, ids);
    const recent = this.recentThreadsByOwner.get(receipt.ownerUserId) ?? new Map<string, number>();
    const previous = recent.get(receipt.threadId);
    if (previous === undefined || receipt.occurredAt > previous) recent.set(receipt.threadId, receipt.occurredAt);
    this.recentThreadsByOwner.set(receipt.ownerUserId, recent);
    return { receipt, inserted: true };
  }

  async get(receiptId: string): Promise<ThreadProgressReceiptV1 | null> {
    return this.receipts.get(receiptId) ?? null;
  }

  async listByThread(
    ownerUserId: string,
    threadId: string,
    options: { readonly limit?: number } = {},
  ): Promise<ThreadProgressReceiptV1[]> {
    const ids = this.threadIndex.get(threadIndexKey(ownerUserId, threadId)) ?? [];
    return ids.slice(0, options.limit ?? ids.length).map((id) => this.requiredReceipt(id));
  }

  async listPageByThread(
    ownerUserId: string,
    threadId: string,
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<{ items: ThreadProgressReceiptV1[]; nextCursor: string | null }> {
    const ids = this.threadIndex.get(threadIndexKey(ownerUserId, threadId)) ?? [];
    const start = options.cursor ? ids.indexOf(options.cursor) + 1 : 0;
    if (options.cursor && start === 0) return { items: [], nextCursor: null };
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const pageIds = ids.slice(start, start + limit);
    return {
      items: pageIds.map((id) => this.requiredReceipt(id)),
      nextCursor: start + pageIds.length < ids.length ? (pageIds.at(-1) ?? null) : null,
    };
  }

  async listRecentThreads(
    ownerUserId: string,
    options: ListRecentThreadOptions = {},
  ): Promise<{ items: ThreadProgressRecentThread[]; nextCursor: string | null }> {
    const ordered = [...(this.recentThreadsByOwner.get(ownerUserId)?.entries() ?? [])]
      .map(([threadId, lastProgressAt]) => ({ threadId, lastProgressAt }))
      .sort(compareRecentThreads);
    const cursor = options.cursor ? decodeRecentThreadCursor(options.cursor) : null;
    const cursorIndex = cursor
      ? ordered.findIndex((item) => item.threadId === cursor.threadId && item.lastProgressAt === cursor.lastProgressAt)
      : -1;
    if (cursor && cursorIndex < 0) throw new InvalidThreadProgressCursorError('Unknown recent thread cursor');
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const eligible = ordered
      .slice(cursorIndex + 1)
      .filter((item) => !options.excludeThreadIds?.has(item.threadId))
      .slice(0, limit + 1);
    const items = eligible.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: eligible.length > limit && last ? encodeRecentThreadCursor(last) : null,
    };
  }

  private requiredReceipt(receiptId: string): ThreadProgressReceiptV1 {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) throw new Error(`Thread progress index points to missing receipt: ${receiptId}`);
    return receipt;
  }
}

function threadIndexKey(ownerUserId: string, threadId: string): string {
  return `${ownerUserId}\u0000${threadId}`;
}

function compareReceipts(left: ThreadProgressReceiptV1, right: ThreadProgressReceiptV1): number {
  return right.occurredAt - left.occurredAt || right.id.localeCompare(left.id);
}

function compareRecentThreads(left: ThreadProgressRecentThread, right: ThreadProgressRecentThread): number {
  return right.lastProgressAt - left.lastProgressAt || left.threadId.localeCompare(right.threadId);
}

export function encodeRecentThreadCursor(value: ThreadProgressRecentThread): string {
  return Buffer.from(JSON.stringify([value.lastProgressAt, value.threadId]), 'utf8').toString('base64url');
}

export function decodeRecentThreadCursor(cursor: string): ThreadProgressRecentThread {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 2 ||
      !Number.isFinite(value[0]) ||
      typeof value[1] !== 'string' ||
      value[1].length === 0
    ) {
      throw new Error('invalid shape');
    }
    return { lastProgressAt: value[0] as number, threadId: value[1] };
  } catch {
    throw new InvalidThreadProgressCursorError('Invalid recent thread cursor');
  }
}
