/**
 * Push Subscription Store
 * 管理 Web Push 订阅记录 — 铲屎官的设备订阅信息
 */

export interface PushSubscriptionRecord {
  /** Web Push endpoint URL — 每个浏览器/设备唯一 */
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userId: string;
  createdAt: number;
  userAgent?: string;
}

export interface IPushSubscriptionStore {
  upsert(record: PushSubscriptionRecord): void | Promise<void>;
  remove(endpoint: string): boolean | Promise<boolean>;
  /** Remove only if the subscription belongs to this user. Returns false on mismatch or missing. */
  removeForUser(userId: string, endpoint: string): boolean | Promise<boolean>;
  listByUser(userId: string): PushSubscriptionRecord[] | Promise<PushSubscriptionRecord[]>;
  listAll(): PushSubscriptionRecord[] | Promise<PushSubscriptionRecord[]>;
}

const DEFAULT_MAX = 100;

export class PushSubscriptionStore implements IPushSubscriptionStore {
  private records = new Map<string, PushSubscriptionRecord>();
  private readonly maxRecords: number;

  constructor(options?: { maxRecords?: number }) {
    this.maxRecords = options?.maxRecords ?? DEFAULT_MAX;
  }

  upsert(record: PushSubscriptionRecord): void {
    // If at capacity and this is a new endpoint, evict oldest
    if (this.records.size >= this.maxRecords && !this.records.has(record.endpoint)) {
      const oldestKey = this.records.keys().next().value;
      if (oldestKey) this.records.delete(oldestKey);
    }
    this.records.set(record.endpoint, record);
  }

  remove(endpoint: string): boolean {
    return this.records.delete(endpoint);
  }

  removeForUser(userId: string, endpoint: string): boolean {
    const rec = this.records.get(endpoint);
    if (!rec || rec.userId !== userId) return false;
    return this.records.delete(endpoint);
  }

  listByUser(userId: string): PushSubscriptionRecord[] {
    const result: PushSubscriptionRecord[] = [];
    for (const rec of this.records.values()) {
      if (rec.userId === userId) result.push(rec);
    }
    return result;
  }

  listAll(): PushSubscriptionRecord[] {
    return [...this.records.values()];
  }
}
