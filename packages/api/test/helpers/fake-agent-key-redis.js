/** The Redis surface RedisAgentKeyBackend uses, in memory (moved from agent-key-registry.test.js). */
export class FakeRedis {
  constructor() {
    this.hashes = new Map();
    this.sets = new Map();
    this.values = new Map();
  }

  async hset(key, ...fields) {
    const hash = this.hashes.get(key) ?? new Map();
    for (let i = 0; i < fields.length; i += 2) {
      hash.set(String(fields[i]), String(fields[i + 1]));
    }
    this.hashes.set(key, hash);
    return fields.length / 2;
  }

  async hgetall(key) {
    const hash = this.hashes.get(key);
    if (!hash) return {};
    return Object.fromEntries(hash.entries());
  }

  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async sadd(key, member) {
    const set = this.sets.get(key) ?? new Set();
    const before = set.size;
    set.add(member);
    this.sets.set(key, set);
    return set.size === before ? 0 : 1;
  }

  async srem(key, member) {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }

  async smembers(key) {
    return [...(this.sets.get(key) ?? new Set())];
  }

  async pexpireat() {
    return 1;
  }

  async exists(key) {
    return this.hashes.has(key) || this.sets.has(key) || this.values.has(key) ? 1 : 0;
  }

  async set(key, value, expiryMode, ttlMs, setMode) {
    if (expiryMode !== 'PX' || typeof ttlMs !== 'number' || setMode !== 'NX') {
      throw new Error('FakeRedis only supports SET key value PX ttl NX');
    }
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }
}
