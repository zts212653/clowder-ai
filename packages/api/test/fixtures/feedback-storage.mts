import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  createPluginStorageHost,
  RedisPluginPrivateStorage,
} from '../../src/domains/plugin/host-surface/plugin-private-storage.js';

/** Real Host encoder/decoder/CAS port, with only Redis hash/Lua transport replaced. No socket is opened. */
export function feedbackStorageFixture() {
  const hashes = new Map<string, Map<string, string>>();
  let revision = 0;
  const redis = {
    hget: async (namespace: string, key: string) => hashes.get(namespace)?.get(key) ?? null,
    hgetall: async (namespace: string) => Object.fromEntries(hashes.get(namespace) ?? []),
    eval: async (_script: string, _keys: number, namespace: string, key: string, expected: string, encoded: string) => {
      if (!_script.includes('plugin-private-storage:write-v1')) throw new Error('unexpected storage mutation');
      const hash = hashes.get(namespace) ?? new Map<string, string>();
      const current = hash.get(key)?.split(':')[0] ?? '';
      if (expected !== '*' && current !== expected) return 0;
      const next = ++revision;
      hash.set(key, `${next}:v:${encoded}`);
      hashes.set(namespace, hash);
      return next;
    },
  };
  const port = new RedisPluginPrivateStorage(redis as unknown as RedisClient);
  return {
    storage: createPluginStorageHost({ pluginId: 'fixture', storage: port }),
    entries: () => port.list('fixture'),
  };
}
