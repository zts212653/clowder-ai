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
  set(key: string, value: string, exToken?: 'EX', ttl?: number): Promise<string | null>;
}

const NOTIFIED_KEY_PREFIX = 'f141:notified:';
const BASELINE_KEY_PREFIX = 'f141:baseline:';

export class ReconciliationDedup {
  constructor(private readonly redis: ReconciliationRedisLike) {}

  private notifiedKey(repo: string, type: 'pr' | 'issue', number: number): string {
    return `${NOTIFIED_KEY_PREFIX}${repo}#${type}-${number}`;
  }

  private baselineKey(repo: string): string {
    return `${BASELINE_KEY_PREFIX}${repo}`;
  }

  async isNotified(repo: string, type: 'pr' | 'issue', number: number): Promise<boolean> {
    const result = await this.redis.get(this.notifiedKey(repo, type, number));
    if (result === null) return false;

    // Older F141 keys were written with a 7-day TTL. Touching them during
    // scans makes the "already notified" fact persistent instead of letting
    // long-open issues reappear every week.
    // TODO(2026-07-01): remove this migration rewrite after TTL-backed keys
    // have either expired or been upgraded in live Redis.
    await this.markNotified(repo, type, number);
    return true;
  }

  async markNotified(repo: string, type: 'pr' | 'issue', number: number): Promise<void> {
    await this.redis.set(this.notifiedKey(repo, type, number), '1');
  }

  async isBaselineEstablished(repo: string): Promise<boolean> {
    return (await this.redis.get(this.baselineKey(repo))) !== null;
  }

  async markBaselineEstablished(repo: string): Promise<void> {
    await this.redis.set(this.baselineKey(repo), '1');
  }
}
