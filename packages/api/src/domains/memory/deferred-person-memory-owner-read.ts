import { createHash } from 'node:crypto';
import { type DeferredPersonMemoryReceipt, deferredPersonMemoryReceiptSchema } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DeferredPersonMemoryReceiptKeys } from './deferred-person-memory-redis-contract.js';

/** Receipts are schema-normalized before this revision is computed. */
export function deferredPersonMemoryOwnerRevision(receipt: DeferredPersonMemoryReceipt): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(receipt)).digest('hex')}`;
}

export function projectDeferredPersonMemoryReceipt(receipt: DeferredPersonMemoryReceipt) {
  return {
    receiptId: receipt.receiptId,
    revision: deferredPersonMemoryOwnerRevision(receipt),
    ...(receipt.subject ? { subject: receipt.subject } : {}),
    state: receipt.state,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    sourceCount: receipt.sourceCoordinates?.length ?? 0,
    ...(receipt.ownerForget ? { pendingAction: 'forget' as const } : {}),
    ...(receipt.proposalId ? { proposalId: receipt.proposalId } : {}),
  };
}

/** Owner pages read the canonical records, including states absent from the clerk ready queue. */
export async function listOwnerDeferredPersonMemoryPage(
  redis: RedisClient,
  ownerUserId: string,
  options: { cursor?: string; limit?: number },
) {
  const clientPrefix = redis.options.keyPrefix ?? '';
  const receiptPrefix = DeferredPersonMemoryReceiptKeys.receipt(ownerUserId, '');
  const physicalPrefix = `${clientPrefix}${receiptPrefix}`;
  const pattern = physicalPrefix.replace(/[\\*?[\]]/gu, '\\$&');
  const targetCount = Math.max(1, Math.min(50, options.limit ?? 20));
  const entries = new Map<string, DeferredPersonMemoryReceipt>();
  let cursor = options.cursor ?? '0';
  // Each HTTP page has at most 10 COUNT=200 work windows. COUNT is a Redis hint,
  // so keep every match in each returned window instead of slicing away continuation data.
  for (let window = 0; window < 10; window += 1) {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${pattern}*`, 'COUNT', 200);
    const records = await Promise.all(
      keys
        .filter((key) => key.startsWith(physicalPrefix))
        .map(async (key) => {
          const raw = await redis.get(key.slice(clientPrefix.length));
          if (!raw) return null;
          const receipt = deferredPersonMemoryReceiptSchema.parse(JSON.parse(raw));
          return receipt.ownerUserId === ownerUserId &&
            key === `${clientPrefix}${DeferredPersonMemoryReceiptKeys.receipt(ownerUserId, receipt.receiptId)}`
            ? receipt
            : null;
        }),
    );
    for (const record of records) if (record) entries.set(record.receiptId, record);
    cursor = nextCursor;
    if (cursor === '0' || entries.size >= targetCount) break;
  }
  return { entries: [...entries.values()], nextCursor: cursor === '0' ? null : cursor };
}
