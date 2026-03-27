/**
 * F141: Redis Delivery ID Dedup (KD-13)
 *
 * Three-phase dedup: claim → confirm → rollback.
 * If delivery fails, rollback releases the claim so GitHub's retry succeeds.
 */

export interface RedisLike {
  // Two overloads matching ioredis SET signatures used by this class
  set(key: string, value: string, exToken: 'EX', ttl: number, nxToken: 'NX'): Promise<string | null>;
  set(key: string, value: string, exToken: 'EX', ttl: number): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

const KEY_PREFIX = 'f141:delivery:';
const TTL_SECONDS = 86400; // 24h

export class RedisDeliveryDedup {
  constructor(private readonly redis: RedisLike) {}

  async claim(deliveryId: string): Promise<boolean> {
    const result = await this.redis.set(KEY_PREFIX + deliveryId, 'pending', 'EX', TTL_SECONDS, 'NX');
    return result === 'OK';
  }

  async confirm(deliveryId: string): Promise<void> {
    await this.redis.set(KEY_PREFIX + deliveryId, 'confirmed', 'EX', TTL_SECONDS);
  }

  async rollback(deliveryId: string): Promise<void> {
    await this.redis.del(KEY_PREFIX + deliveryId);
  }
}
