import type { Redis } from 'ioredis';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { memoryKey } from '../../cats/services/stores/redis-keys/memory-keys.js';
import { currentPluginCallContext } from '../carrier/plugin-call-context.js';

const COMPARE_AND_SET_HASH = `
  local expected = cjson.decode(ARGV[1])
  if redis.call('HLEN', KEYS[1]) ~= #expected then return 0 end
  for _, field in ipairs(expected) do
    if redis.call('HGET', KEYS[1], field[1]) ~= field[2] then return 0 end
  end
  redis.call('HSET', KEYS[1], ARGV[2], ARGV[3])
  if ARGV[4] ~= '' and ARGV[4] ~= ARGV[2] then redis.call('HDEL', KEYS[1], ARGV[4]) end
  return 1
`;
const DEFAULT_MEMORY_HASH = memoryKey('default');

export interface MemoryThreadKvPort {
  get(threadRef: string, key: string): Promise<string | null>;
  list(threadRef: string): Promise<Record<string, string>>;
  compareAndSet(
    threadRef: string,
    expected: Record<string, string>,
    mutation: { set: { key: string; value: string }; removeKey?: string },
  ): Promise<boolean>;
  delete(threadRef: string, key: string): Promise<boolean>;
}

export function redisMemoryThreadKvBacking(
  redis: Pick<Redis, 'hget' | 'hgetall' | 'eval' | 'hdel'>,
): MemoryThreadKvPort {
  return {
    get: (hash, key) => redis.hget(hash, key),
    list: (hash) => redis.hgetall(hash),
    compareAndSet: async (hash, expected, mutation) =>
      (await redis.eval(
        COMPARE_AND_SET_HASH,
        1,
        hash,
        JSON.stringify(Object.entries(expected)),
        mutation.set.key,
        mutation.set.value,
        mutation.removeKey ?? '',
      )) === 1,
    delete: async (hash, key) => (await redis.hdel(hash, key)) > 0,
  };
}

/** Used only for an explicitly ephemeral deployment, with state scoped to the Host process. */
export function transientMemoryThreadKvBacking(): MemoryThreadKvPort {
  const hashes = new Map<string, Map<string, string>>();
  return {
    get: async (hash, key) => hashes.get(hash)?.get(key) ?? null,
    list: async (hash) => Object.fromEntries(hashes.get(hash) ?? []),
    compareAndSet: async (hash, expected, mutation) => {
      const current = hashes.get(hash) ?? new Map<string, string>();
      const fields = Object.entries(expected);
      if (current.size !== fields.length || fields.some(([key, value]) => current.get(key) !== value)) return false;
      current.set(mutation.set.key, mutation.set.value);
      if (mutation.removeKey !== undefined && mutation.removeKey !== mutation.set.key) {
        current.delete(mutation.removeKey);
      }
      hashes.set(hash, current);
      return true;
    },
    delete: async (hash, key) => {
      const current = hashes.get(hash);
      if (!current?.delete(key)) return false;
      if (current.size === 0) hashes.delete(hash);
      return true;
    },
  };
}

/** The memory plugin owns record policy. The Host owns scope and the legacy hash coordinates. */
export function createMemoryThreadKvPort(options: {
  pluginInstanceId: string;
  ownerUserId: string;
  threads: Pick<IThreadStore, 'get'>;
  backing: MemoryThreadKvPort;
  assertActivation(): void;
}): MemoryThreadKvPort {
  async function authorize<T>(threadRef: string, access: (key: string) => Promise<T>) {
    options.assertActivation();
    const caller = currentPluginCallContext(options.pluginInstanceId);
    if (!caller || caller.threadId !== threadRef) throw new Error('memory_thread_access_denied');
    if (threadRef === 'default') {
      if (caller.userId !== options.ownerUserId) throw new Error('memory_thread_access_denied');
    } else if ((await options.threads.get(threadRef))?.createdBy !== caller.userId) {
      throw new Error('memory_thread_access_denied');
    }
    await caller.assertCurrent();
    options.assertActivation();
    return access(threadRef === 'default' ? DEFAULT_MEMORY_HASH : memoryKey(threadRef));
  }

  return {
    get: (threadRef, key) => authorize(threadRef, (hash) => options.backing.get(hash, key)),
    list: (threadRef) => authorize(threadRef, (hash) => options.backing.list(hash)),
    compareAndSet: (threadRef, expected, mutation) =>
      authorize(threadRef, (hash) => options.backing.compareAndSet(hash, expected, mutation)),
    delete: (threadRef, key) => authorize(threadRef, (hash) => options.backing.delete(hash, key)),
  };
}
