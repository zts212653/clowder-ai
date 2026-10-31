import { createHash } from 'node:crypto';
import type { MemoryOwnerActionReceipt } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';

export type OwnerMemoryLane = 'profile' | 'taste' | 'entity' | 'event';

export interface OwnerMemoryActionReceiptRecord {
  version: 1;
  ownerUserId: string;
  lane: OwnerMemoryLane;
  memoryId: string;
  requestId: string;
  requestDigest: string;
  status: 'pending' | 'applied';
  startedAt: number;
  completedAt?: number;
  result?: MemoryOwnerActionReceipt;
}

export interface OwnerMemoryActionReceiptStore {
  read(input: OwnerMemoryActionReceiptKey): Promise<OwnerMemoryActionReceiptRecord | null>;
  begin(record: OwnerMemoryActionReceiptRecord): Promise<OwnerMemoryActionReceiptRecord>;
  complete(
    key: OwnerMemoryActionReceiptKey,
    requestDigest: string,
    result: MemoryOwnerActionReceipt,
    completedAt: number,
  ): Promise<boolean>;
  clearPending(key: OwnerMemoryActionReceiptKey, requestDigest: string): Promise<boolean>;
}

export type OwnerMemoryActionReceiptKey = Pick<
  OwnerMemoryActionReceiptRecord,
  'ownerUserId' | 'lane' | 'memoryId' | 'requestId'
>;

function clone(record: OwnerMemoryActionReceiptRecord): OwnerMemoryActionReceiptRecord {
  return structuredClone(record);
}

export class InMemoryOwnerMemoryActionReceiptStore implements OwnerMemoryActionReceiptStore {
  private readonly records = new Map<string, OwnerMemoryActionReceiptRecord>();

  async read(input: OwnerMemoryActionReceiptKey): Promise<OwnerMemoryActionReceiptRecord | null> {
    const found = this.records.get(receiptKey(input));
    return found ? clone(found) : null;
  }

  async begin(record: OwnerMemoryActionReceiptRecord): Promise<OwnerMemoryActionReceiptRecord> {
    const key = receiptKey(record);
    const existing = this.records.get(key);
    if (existing) return clone(existing);
    this.records.set(key, clone(record));
    return clone(record);
  }

  async complete(
    key: OwnerMemoryActionReceiptKey,
    requestDigest: string,
    result: MemoryOwnerActionReceipt,
    completedAt: number,
  ): Promise<boolean> {
    const storedKey = receiptKey(key);
    const current = this.records.get(storedKey);
    if (!current || current.status !== 'pending' || current.requestDigest !== requestDigest) return false;
    this.records.set(storedKey, { ...current, status: 'applied', completedAt, result: structuredClone(result) });
    return true;
  }

  async clearPending(key: OwnerMemoryActionReceiptKey, requestDigest: string): Promise<boolean> {
    const storedKey = receiptKey(key);
    const current = this.records.get(storedKey);
    if (!current || current.status !== 'pending' || current.requestDigest !== requestDigest) return false;
    return this.records.delete(storedKey);
  }
}

export class RedisOwnerMemoryActionReceiptStore implements OwnerMemoryActionReceiptStore {
  constructor(private readonly redis: RedisClient) {}

  async read(input: OwnerMemoryActionReceiptKey): Promise<OwnerMemoryActionReceiptRecord | null> {
    const raw = await this.redis.get(receiptKey(input));
    return raw ? parseRecord(raw) : null;
  }

  async begin(record: OwnerMemoryActionReceiptRecord): Promise<OwnerMemoryActionReceiptRecord> {
    const key = receiptKey(record);
    const inserted = await this.redis.set(key, JSON.stringify(record), 'NX');
    if (inserted === 'OK') return clone(record);
    return (await this.read(record)) ?? record;
  }

  async complete(
    key: OwnerMemoryActionReceiptKey,
    requestDigest: string,
    result: MemoryOwnerActionReceipt,
    completedAt: number,
  ): Promise<boolean> {
    const redisKey = receiptKey(key);
    const current = await this.read(key);
    if (!current || current.status !== 'pending' || current.requestDigest !== requestDigest) return false;
    const completed: OwnerMemoryActionReceiptRecord = {
      ...current,
      status: 'applied',
      completedAt,
      result: structuredClone(result),
    };
    await this.redis.set(redisKey, JSON.stringify(completed));
    return true;
  }

  async clearPending(key: OwnerMemoryActionReceiptKey, requestDigest: string): Promise<boolean> {
    const current = await this.read(key);
    if (!current || current.status !== 'pending' || current.requestDigest !== requestDigest) return false;
    return (await this.redis.del(receiptKey(key))) > 0;
  }
}

function receiptKey(input: OwnerMemoryActionReceiptKey): string {
  const digest = createHash('sha256')
    .update([input.ownerUserId, input.lane, input.memoryId, input.requestId].join('\0'))
    .digest('hex');
  return `owner-memory-action:${digest}`;
}

function parseRecord(raw: string): OwnerMemoryActionReceiptRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<OwnerMemoryActionReceiptRecord>;
    if (
      value.version !== 1 ||
      typeof value.ownerUserId !== 'string' ||
      typeof value.lane !== 'string' ||
      typeof value.memoryId !== 'string' ||
      typeof value.requestId !== 'string' ||
      typeof value.requestDigest !== 'string' ||
      (value.status !== 'pending' && value.status !== 'applied') ||
      typeof value.startedAt !== 'number'
    ) {
      return null;
    }
    return value as OwnerMemoryActionReceiptRecord;
  } catch {
    return null;
  }
}
