import { PluginPrivateStorageIndex } from './storage/PluginPrivateStorageIndex.js';
import {
  type PluginStorageDueInput,
  type PluginStorageDuePage,
  type PluginStorageProjection,
  pluginStorageRecord,
} from './storage/plugin-storage-index-contract.js';

export type {
  PluginStorageDueInput,
  PluginStorageDuePage,
  PluginStorageProjection,
} from './storage/plugin-storage-index-contract.js';

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
  local revision, kind = string.match(raw, '^(%d+):([vid]):')
  if kind == 'i' then return redis.error_reply('indexed_storage_projection_required') end
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
local revision, kind = string.match(raw, '^(%d+):([vid]):')
if kind == 'i' then return -1 end
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

export interface PluginStorageScanInput {
  readonly prefix: string;
  readonly suffix?: string;
  readonly cursor?: string;
  /** Redis COUNT is a work hint, not a response-size or snapshot guarantee. */
  readonly count?: number;
}

export interface PluginStoragePage {
  /** Continue even after an empty page; only "0" completes an iteration. */
  readonly cursor: string;
  readonly entries: Readonly<Record<string, PluginStorageEntry>>;
}

export interface PluginPrivateStoragePort {
  compareAndSetIndexed?(
    pluginId: string,
    key: string,
    expectedRevision: number | null,
    value: unknown,
    projection: PluginStorageProjection,
  ): Promise<PluginStorageCompareAndSetResult>;
  readDue?(pluginId: string, input: PluginStorageDueInput): Promise<PluginStorageDuePage>;
  rebuildIndex?(pluginId: string, index: string): Promise<{ status: 'ready'; version: string }>;
  get(pluginId: string, key: string): Promise<PluginStorageEntry | undefined>;
  list(pluginId: string): Promise<Readonly<Record<string, PluginStorageEntry>>>;
  scan?(pluginId: string, input: PluginStorageScanInput): Promise<PluginStoragePage>;
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
  compareAndSetIndexed?(
    key: string,
    expectedRevision: number | null,
    value: unknown,
    projection: PluginStorageProjection,
  ): Promise<PluginStorageCompareAndSetResult>;
  readDue?(input: PluginStorageDueInput): Promise<PluginStorageDuePage>;
  rebuildIndex?(index: string): Promise<{ status: 'ready'; version: string }>;
  get(key: string): Promise<PluginStorageEntry | undefined>;
  list(): Promise<Readonly<Record<string, PluginStorageEntry>>>;
  scan?(input: PluginStorageScanInput): Promise<PluginStoragePage>;
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
  readonly storage?: PluginPrivateStoragePort;
}): PluginStorageHost {
  const requireService = () => {
    if (!input.storage) {
      throw new ExternalPluginRuntimeError('UNSUPPORTED_TRANSPORT', 'Host plugin storage is unavailable');
    }
    return input.storage;
  };
  const scan = input.storage?.scan?.bind(input.storage, input.pluginId);
  const compareAndSetIndexed = input.storage?.compareAndSetIndexed?.bind(input.storage, input.pluginId);
  const readDue = input.storage?.readDue?.bind(input.storage, input.pluginId);
  const rebuildIndex = input.storage?.rebuildIndex?.bind(input.storage, input.pluginId);
  return {
    get: (key) => requireService().get(input.pluginId, key),
    list: () => requireService().list(input.pluginId),
    ...(scan ? { scan } : {}),
    ...(compareAndSetIndexed ? { compareAndSetIndexed } : {}),
    ...(readDue ? { readDue } : {}),
    ...(rebuildIndex ? { rebuildIndex } : {}),
    set: (key, value) => requireService().set(input.pluginId, key, value),
    compareAndSet: (key, expectedRevision, value) =>
      requireService().compareAndSet(input.pluginId, key, expectedRevision, value),
    delete: (key, expectedRevision) => requireService().delete(input.pluginId, key, expectedRevision),
  };
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
  const { revision, value } = pluginStorageRecord(raw);
  return { revision, value };
}

/** Durable, plugin-id-scoped JSON records. No method in this adapter creates a TTL. */
export class RedisPluginPrivateStorage implements PluginPrivateStoragePort {
  /** keyPrefix is a Host composition choice; it is never part of the package facade. */
  constructor(
    private readonly redis: RedisClient,
    private readonly keyPrefix = 'plugin-private-state:v1',
  ) {}

  private hashKey(pluginId: string): string {
    return `${this.keyPrefix}:${encodeURIComponent(pluginId)}`;
  }

  async get(pluginId: string, key: string): Promise<PluginStorageEntry | undefined> {
    assertStorageKey(key);
    const raw = await this.redis.hget(this.hashKey(pluginId), key);
    if (raw === null) return undefined;
    return decodeRecord(raw);
  }

  async list(pluginId: string): Promise<Readonly<Record<string, PluginStorageEntry>>> {
    const raw = await this.redis.hgetall(this.hashKey(pluginId));
    return Object.fromEntries(
      Object.entries(raw)
        .filter(([key]) => key !== REVISION_COUNTER_FIELD)
        .map(([key, value]) => [key, decodeRecord(value)]),
    );
  }

  async scan(pluginId: string, input: PluginStorageScanInput): Promise<PluginStoragePage> {
    if (typeof input?.prefix !== 'string' || input.prefix.length > MAX_STORAGE_KEY_LENGTH) {
      throw new TypeError(`plugin storage prefix must be a string of at most ${MAX_STORAGE_KEY_LENGTH} characters`);
    }
    if (
      input.suffix !== undefined &&
      (typeof input.suffix !== 'string' || input.suffix.length > MAX_STORAGE_KEY_LENGTH)
    ) {
      throw new TypeError(`plugin storage suffix must be a string of at most ${MAX_STORAGE_KEY_LENGTH} characters`);
    }
    const cursor = input.cursor ?? '0';
    if (typeof cursor !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(cursor)) {
      throw new TypeError('plugin storage cursor must be a Redis unsigned decimal cursor');
    }
    const count = input.count ?? 50;
    if (!Number.isSafeInteger(count) || count < 1 || count > 200) {
      throw new TypeError('plugin storage scan count must be an integer from 1 to 200');
    }
    const literal = (value: string) => value.replace(/[?*[\]\\]/g, '\\$&');
    const pattern = `${literal(input.prefix)}*${literal(input.suffix ?? '')}`;
    const [next, fields] = await this.redis.hscan(this.hashKey(pluginId), cursor, 'MATCH', pattern, 'COUNT', count);
    const entries: [string, PluginStorageEntry][] = [];
    for (let index = 0; index < fields.length; index += 2) {
      const key = fields[index];
      if (key !== REVISION_COUNTER_FIELD) entries.push([key, decodeRecord(fields[index + 1])]);
    }
    return { cursor: next, entries: Object.fromEntries(entries) };
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
    for (let attempt = 0; attempt < 5; attempt++) {
      const indexed = await this.indexOwner(pluginId).deleteIndexed(key, expectedRevision);
      const revision =
        indexed ??
        Number(
          await this.redis.eval(
            DELETE_LUA,
            1,
            this.hashKey(pluginId),
            key,
            expectedRevision === undefined ? '*' : String(expectedRevision),
          ),
        );
      if (revision === -1) continue; // A native indexed writer won after the legacy read.
      if (!Number.isSafeInteger(revision) || revision < 0)
        throw new TypeError('plugin storage returned an invalid revision');
      return revision === 0 ? { deleted: false } : { deleted: true, revision };
    }
    throw new Error('plugin storage delete raced; retry current record');
  }

  private indexOwner(pluginId: string) {
    return new PluginPrivateStorageIndex(
      this.redis,
      this.hashKey(pluginId),
      `${this.keyPrefix}:index:${encodeURIComponent(pluginId)}`,
    );
  }
  async compareAndSetIndexed(
    pluginId: string,
    key: string,
    expectedRevision: number | null,
    value: unknown,
    projection: PluginStorageProjection,
  ): Promise<PluginStorageCompareAndSetResult> {
    assertStorageKey(key);
    if (expectedRevision !== null && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1))
      throw new TypeError('plugin storage expectedRevision must be null or a positive safe integer');
    const revision = await this.indexOwner(pluginId).publish(key, expectedRevision, encodeValue(value), projection);
    return revision === 0 ? { applied: false } : { applied: true, revision };
  }
  readDue(pluginId: string, input: PluginStorageDueInput) {
    return this.indexOwner(pluginId).readDue(input);
  }
  rebuildIndex(pluginId: string, index: string) {
    return this.indexOwner(pluginId).rebuild(index);
  }

  async #write(pluginId: string, key: string, expectedRevision: string, value: unknown): Promise<number> {
    assertStorageKey(key);
    const revision = Number(
      await this.redis.eval(WRITE_LUA, 1, this.hashKey(pluginId), key, expectedRevision, encodeValue(value)),
    );
    if (!Number.isSafeInteger(revision) || revision < 0)
      throw new TypeError('plugin storage returned an invalid revision');
    return revision;
  }
}
