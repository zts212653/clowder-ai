import type {
  PluginPrivateStoragePort,
  PluginStorageEntry,
} from '../../src/domains/plugin/host-surface/plugin-private-storage.js';

export function memoryPluginStorage(): PluginPrivateStoragePort {
  const records = new Map<string, Map<string, PluginStorageEntry>>();
  let revision = 0;
  const bucket = (pluginId: string) => {
    const existing = records.get(pluginId);
    if (existing) return existing;
    const created = new Map<string, PluginStorageEntry>();
    records.set(pluginId, created);
    return created;
  };
  return {
    async get(pluginId, key) {
      return bucket(pluginId).get(key);
    },
    async list(pluginId) {
      return Object.fromEntries(bucket(pluginId));
    },
    async set(pluginId, key, value) {
      revision += 1;
      bucket(pluginId).set(key, { revision, value });
      return { revision };
    },
    async compareAndSet(pluginId, key, expectedRevision, value) {
      const current = bucket(pluginId).get(key);
      if ((current?.revision ?? null) !== expectedRevision) return { applied: false };
      revision += 1;
      bucket(pluginId).set(key, { revision, value });
      return { applied: true, revision };
    },
    async delete(pluginId, key, expectedRevision) {
      const current = bucket(pluginId).get(key);
      if (!current || (expectedRevision !== undefined && current.revision !== expectedRevision)) {
        return { deleted: false };
      }
      revision += 1;
      bucket(pluginId).delete(key);
      return { deleted: true, revision };
    },
  };
}
