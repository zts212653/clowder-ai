import type { ThreadProgressReceiptV1 } from '@cat-cafe/shared';

export interface AppendThreadProgressReceiptResult {
  readonly receipt: ThreadProgressReceiptV1;
  readonly inserted: boolean;
}

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
}

/** In-memory implementation used only by explicit memory mode and isolated tests. */
export class ThreadProgressReceiptStore implements IThreadProgressReceiptStore {
  private readonly receipts = new Map<string, ThreadProgressReceiptV1>();
  private readonly sourceIndex = new Map<string, string>();
  private readonly terminalTurnIndex = new Map<string, string>();
  private readonly threadIndex = new Map<string, string[]>();

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
