// The production RedisDraftStore's hash/set wire, with no network or Redis server.
export class HashRedis {
  hashes = new Map();
  sets = new Map();
  expirations = [];
  persistentKeys = new Set();

  async hget(key, field) {
    return this.hashes.get(key)?.[field] ?? null;
  }
  async hgetall(key) {
    return { ...this.hashes.get(key) };
  }
  async hset(key, fields) {
    this.hashes.set(key, { ...this.hashes.get(key), ...fields });
    return 1;
  }
  async hsetnx(key, field, value) {
    if (this.hashes.get(key)?.[field] !== undefined) return 0;
    return this.hset(key, { [field]: value });
  }
  async hdel(key, field) {
    const record = this.hashes.get(key);
    if (record) delete record[field];
    return 1;
  }
  async sadd(key, value) {
    const set = this.sets.get(key) ?? new Set();
    set.add(value);
    this.sets.set(key, set);
    return 1;
  }
  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }
  async srem(key, ...values) {
    for (const value of values) this.sets.get(key)?.delete(value);
    return 1;
  }
  async del(key) {
    this.hashes.delete(key);
    this.sets.delete(key);
    return 1;
  }
  async expire(_key, seconds) {
    this.expirations.push(seconds);
    return 1;
  }
  async persist(key) {
    this.persistentKeys.add(key);
    return 1;
  }
  multi() {
    const operations = [];
    const pipeline = {};
    for (const method of ['hgetall', 'hset', 'hsetnx', 'hdel', 'sadd', 'srem', 'del', 'persist', 'expire']) {
      pipeline[method] = (...args) => {
        operations.push(() => this[method](...args));
        return pipeline;
      };
    }
    pipeline.exec = async () => Promise.all(operations.map(async (operation) => [null, await operation()]));
    return pipeline;
  }
}
