import type { RedisClient } from '@cat-cafe/shared/utils';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';

const MAX_STORAGE_KEY_LENGTH = 256;
const MAX_STORAGE_VALUE_BYTES = 1024 * 1024;
const REVISION_COUNTER_FIELD = '';

const WRITE_LUA = `
-- plugin-private-storage:write-v1
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local currentRevision = nil
if raw then
  local revision, kind = string.match(raw, '^(%d+):([vd]):')
  if not revision or kind ~= 'v' then return redis.error_reply('malformed plugin storage record') end
  currentRevision = tonumber(revision)
end
if ARGV[2] ~= '*' then
  local expectedRevision = ARGV[2] == '' and nil or tonumber(ARGV[2])
  if currentRevision ~= expectedRevision then return 0 end
end
local nextRevision = redis.call('HINCRBY', KEYS[1], '', 1)
redis.call('HSET', KEYS[1], ARGV[1], tostring(nextRevision) .. ':v:' .. ARGV[3])
return nextRevision
`;

const DELETE_LUA = `
-- plugin-private-storage:delete-v1
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return 0 end
local revision, kind = string.match(raw, '^(%d+):([vd]):')
if not revision or kind ~= 'v' then return redis.error_reply('malformed plugin storage record') end
local currentRevision = tonumber(revision)
if ARGV[2] ~= '*' and currentRevision ~= tonumber(ARGV[2]) then return 0 end
local nextRevision = redis.call('HINCRBY', KEYS[1], '', 1)
redis.call('HDEL', KEYS[1], ARGV[1])
return nextRevision
`;

export interface PluginStorageEntry {
  /** Opaque monotonic fence. Later writes to the same key are greater; values need not start at 1 or be consecutive. */
  readonly revision: number;
  readonly value: unknown;
}

export interface PluginStorageCompareAndSetResult {
  readonly applied: boolean;
  readonly revision?: number;
}

export interface PluginStorageDeleteResult {
  readonly deleted: boolean;
  readonly revision?: number;
}

export interface PluginPrivateStoragePort {
  get(pluginId: string, key: string): Promise<PluginStorageEntry | undefined>;
  list(pluginId: string): Promise<Readonly<Record<string, PluginStorageEntry>>>;
  set(pluginId: string, key: string, value: unknown): Promise<{ readonly revision: number }>;
  compareAndSet(
    pluginId: string,
    key: string,
    expectedRevision: number | null,
    value: unknown,
  ): Promise<PluginStorageCompareAndSetResult>;
  delete(pluginId: string, key: string, expectedRevision?: number): Promise<PluginStorageDeleteResult>;
}

export interface PluginStorageHost {
  get(key: string): Promise<PluginStorageEntry | undefined>;
  list(): Promise<Readonly<Record<string, PluginStorageEntry>>>;
  set(key: string, value: unknown): Promise<{ readonly revision: number }>;
  compareAndSet(
    key: string,
    expectedRevision: number | null,
    value: unknown,
  ): Promise<PluginStorageCompareAndSetResult>;
  delete(key: string, expectedRevision?: number): Promise<PluginStorageDeleteResult>;
}

export function createPluginStorageHost(input: {
  readonly pluginId: string;
  readonly effectiveGrants: readonly string[];
  readonly storage?: PluginPrivateStoragePort;
}): PluginStorageHost {
  const requireGrant = (capability: 'plugin.state.get' | 'plugin.state.set') => {
    if (!input.effectiveGrants.includes(capability)) {
      throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', `${input.pluginId} lacks ${capability}`);
    }
    if (!input.storage) {
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host plugin storage is unavailable');
    }
    return input.storage;
  };
  return {
    get: (key) => requireGrant('plugin.state.get').get(input.pluginId, key),
    list: () => requireGrant('plugin.state.get').list(input.pluginId),
    set: (key, value) => requireGrant('plugin.state.set').set(input.pluginId, key, value),
    compareAndSet: (key, expectedRevision, value) =>
      requireGrant('plugin.state.set').compareAndSet(input.pluginId, key, expectedRevision, value),
    delete: (key, expectedRevision) => requireGrant('plugin.state.set').delete(input.pluginId, key, expectedRevision),
  };
}

function storageHashKey(pluginId: string): string {
  return `plugin-private-state:v1:${encodeURIComponent(pluginId)}`;
}

function assertStorageKey(key: string): void {
  if (key.length === 0 || key.length > MAX_STORAGE_KEY_LENGTH || key.trim() !== key) {
    throw new TypeError(`plugin storage key must be 1..${MAX_STORAGE_KEY_LENGTH} non-whitespace-trimmed characters`);
  }
}

function encodeValue(value: unknown): string {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError('plugin storage value must be JSON-serializable', { cause: error });
  }
  if (encoded === undefined) throw new TypeError('plugin storage value must be JSON-serializable');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STORAGE_VALUE_BYTES) {
    throw new TypeError(`plugin storage value exceeds ${MAX_STORAGE_VALUE_BYTES} bytes`);
  }
  return encoded;
}

function decodeRecord(raw: string): PluginStorageEntry {
  const match = /^(\d+):v:([\s\S]*)$/.exec(raw);
  const revision = match ? Number(match[1]) : Number.NaN;
  if (!match || !Number.isSafeInteger(revision) || revision < 1) {
    throw new TypeError('plugin storage record is malformed');
  }
  try {
    return { revision, value: JSON.parse(match[2]) };
  } catch (error) {
    throw new TypeError('plugin storage record is malformed', { cause: error });
  }
}

/** Durable, plugin-id-scoped JSON records. No method in this adapter creates a TTL. */
export class RedisPluginPrivateStorage implements PluginPrivateStoragePort {
  constructor(private readonly redis: RedisClient) {}

  async get(pluginId: string, key: string): Promise<PluginStorageEntry | undefined> {
    assertStorageKey(key);
    const raw = await this.redis.hget(storageHashKey(pluginId), key);
    if (raw === null) return undefined;
    return decodeRecord(raw);
  }

  async list(pluginId: string): Promise<Readonly<Record<string, PluginStorageEntry>>> {
    const raw = await this.redis.hgetall(storageHashKey(pluginId));
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([key]) => key !== REVISION_COUNTER_FIELD)
        .map(([key, value]) => [key, decodeRecord(value)]),
    );
  }

  async set(pluginId: string, key: string, value: unknown): Promise<{ readonly revision: number }> {
    const revision = await this.#write(pluginId, key, '*', value);
    return { revision };
  }

  async compareAndSet(
    pluginId: string,
    key: string,
    expectedRevision: number | null,
    value: unknown,
  ): Promise<PluginStorageCompareAndSetResult> {
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new TypeError('plugin storage expectedRevision must be null or a positive safe integer');
    }
    const revision = await this.#write(pluginId, key, expectedRevision === null ? '' : String(expectedRevision), value);
    return revision === 0 ? { applied: false } : { applied: true, revision };
  }

  async delete(pluginId: string, key: string, expectedRevision?: number): Promise<PluginStorageDeleteResult> {
    assertStorageKey(key);
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
      throw new TypeError('plugin storage expectedRevision must be a positive safe integer');
    }
    const revision = Number(
      await this.redis.eval(
        DELETE_LUA,
        1,
        storageHashKey(pluginId),
        key,
        expectedRevision === undefined ? '*' : String(expectedRevision),
      ),
    );
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new TypeError('plugin storage returned an invalid revision');
    return revision === 0 ? { deleted: false } : { deleted: true, revision };
  }

  async #write(pluginId: string, key: string, expectedRevision: string, value: unknown): Promise<number> {
    assertStorageKey(key);
    const revision = Number(
      await this.redis.eval(WRITE_LUA, 1, storageHashKey(pluginId), key, expectedRevision, encodeValue(value)),
    );
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new TypeError('plugin storage returned an invalid revision');
    return revision;
  }
}
