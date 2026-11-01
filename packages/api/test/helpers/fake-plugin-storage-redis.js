export class FakeStorageRedis {
  hashes = new Map();
  ttlCommands = [];

  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key) {
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async eval(script, _keyCount, key, field, expectedRevision, value) {
    const hash = this.hashes.get(key) ?? new Map();
    const currentRaw = hash.get(field);
    const match = currentRaw?.match(/^(\d+):([vd]):(.*)$/s);
    const currentRevision = match === undefined || match === null ? null : Number(match[1]);
    const currentKind = match?.[2];
    if (script.includes('plugin-private-storage:delete-v1')) {
      return this.applyDelete(hash, key, field, currentRevision, currentKind, expectedRevision);
    }
    if (expectedRevision !== '*') {
      const expected = expectedRevision === '' ? null : Number(expectedRevision);
      if (currentRevision !== expected) return 0;
    }
    const revision = Number(hash.get('') ?? 0) + 1;
    hash.set('', String(revision));
    hash.set(field, `${revision}:v:${value}`);
    this.hashes.set(key, hash);
    return revision;
  }

  applyDelete(hash, key, field, currentRevision, currentKind, expectedRevision) {
    if (currentRevision === null || currentKind !== 'v') return 0;
    if (expectedRevision !== '*' && currentRevision !== Number(expectedRevision)) return 0;
    const revision = Number(hash.get('') ?? 0) + 1;
    hash.set('', String(revision));
    hash.delete(field);
    this.hashes.set(key, hash);
    return revision;
  }

  async expire(...args) {
    this.ttlCommands.push(['expire', ...args]);
    return 1;
  }

  async pexpire(...args) {
    this.ttlCommands.push(['pexpire', ...args]);
    return 1;
  }
}
