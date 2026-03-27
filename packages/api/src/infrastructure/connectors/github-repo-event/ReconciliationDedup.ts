/**
 * F141 Phase B: Business-level dedup for reconciliation scanning (KD-15)
 *
 * Separate from transport dedup (RedisDeliveryDedup, delivery IDs).
 * Tracks which PR/Issue numbers have been notified to inbox threads,
 * so Phase B gate can skip items already delivered by Phase A webhook.
 *
 * Key format: f141:notified:{repoFullName}#{type}-{number}
 */

export interface ReconciliationRedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, exToken: 'EX', ttl: number): Promise<string | null>;
}

const KEY_PREFIX = 'f141:notified:';
const TTL_SECONDS = 604800; // 7 days

export class ReconciliationDedup {
  constructor(private readonly redis: ReconciliationRedisLike) {}

  private key(repo: string, type: 'pr' | 'issue', number: number): string {
    return `${KEY_PREFIX}${repo}#${type}-${number}`;
  }

  async isNotified(repo: string, type: 'pr' | 'issue', number: number): Promise<boolean> {
    const result = await this.redis.get(this.key(repo, type, number));
    return result !== null;
  }

  async markNotified(repo: string, type: 'pr' | 'issue', number: number): Promise<void> {
    await this.redis.set(this.key(repo, type, number), '1', 'EX', TTL_SECONDS);
  }
}
