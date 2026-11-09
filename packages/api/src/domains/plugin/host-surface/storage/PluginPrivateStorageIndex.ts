import { randomUUID } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import {
  assertPluginStorageIndex,
  assertPluginStorageProjection,
  type PluginStorageDueInput,
  type PluginStorageDuePage,
  type PluginStorageProjection,
  pluginStorageIndexState,
  pluginStorageRecord,
} from './plugin-storage-index-contract.js';
import { PUBLISH_STORAGE_INDEX, READ_STORAGE_DUE } from './plugin-storage-index-lua.js';
import { rebuildPluginStorageIndex } from './plugin-storage-index-rebuild.js';

/** Index projection belongs to the original private-storage record; this class has no wait/retry/execution policy. */
export class PluginPrivateStorageIndex {
  readonly catalog: string;
  constructor(
    private readonly redis: RedisClient,
    readonly hash: string,
    private readonly indexPrefix: string,
  ) {
    this.catalog = `${indexPrefix}:states`;
  }
  indexKey(index: string, token: string) {
    return `${this.indexPrefix}:${index}:${token}`;
  }
  async publish(
    key: string,
    expected: number | null | '*',
    encodedValue: string,
    projection: PluginStorageProjection,
    mode: 'write' | 'delete' = 'write',
  ): Promise<number> {
    projection = { index: projection?.index, score: projection?.score };
    assertPluginStorageProjection(projection);
    for (let attempt = 0; attempt < 5; attempt++) {
      const raw = await this.redis.hget(this.hash, key);
      if (mode === 'delete' && !raw) return 0;
      if (raw?.match(/^\d+:i:/) && pluginStorageRecord(raw).projection?.index !== projection.index)
        throw new TypeError('plugin storage index identity cannot change');
      const state = pluginStorageIndexState(await this.redis.hget(this.catalog, projection.index));
      const token = state?.token ?? randomUUID();
      const body = `{"v":1,"value":${encodedValue},"projection":${JSON.stringify(projection)}}`;
      const result = Number(
        await this.redis.eval(
          PUBLISH_STORAGE_INDEX,
          3,
          this.hash,
          this.catalog,
          this.indexKey(projection.index, token),
          key,
          raw ?? '',
          expected === null ? '' : String(expected),
          body,
          projection.index,
          token,
          projection.score ?? '',
          mode,
        ),
      );
      if (result !== -1) {
        if (!Number.isSafeInteger(result) || result < 0)
          throw new TypeError('plugin storage returned an invalid revision');
        return result;
      }
    }
    throw new Error('plugin storage indexed publication raced; retry current record');
  }
  async deleteIndexed(key: string, expected?: number): Promise<number | null> {
    const raw = await this.redis.hget(this.hash, key);
    if (!raw || !/^\d+:i:/.test(raw)) return null;
    return this.publish(key, expected ?? '*', 'null', pluginStorageRecord(raw).projection!, 'delete');
  }
  async readDue(input: PluginStorageDueInput): Promise<PluginStorageDuePage> {
    assertPluginStorageIndex(input?.index);
    if (
      !Number.isSafeInteger(input.before) ||
      input.before < 0 ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new TypeError('plugin storage due range/limit is invalid');
    const state = pluginStorageIndexState(await this.redis.hget(this.catalog, input.index));
    if (!state || state.status !== 'ready') return { status: 'not_ready' };
    const raw = (await this.redis.eval(
      READ_STORAGE_DUE,
      3,
      this.hash,
      this.catalog,
      this.indexKey(input.index, state.token),
      input.index,
      state.token,
      input.before,
      input.limit,
    )) as Array<number | string>;
    if (Number(raw[0]) !== 1) return { status: 'not_ready' };
    const entries: Array<[string, { revision: number; value: unknown }]> = [];
    for (let i = 2; i < raw.length; i += 2) {
      const row = pluginStorageRecord(String(raw[i + 1]));
      entries.push([String(raw[i]), { revision: row.revision, value: row.value }]);
    }
    return { status: 'ready', version: String(raw[1]), entries: Object.fromEntries(entries) };
  }
  async rebuild(index: string) {
    assertPluginStorageIndex(index);
    return rebuildPluginStorageIndex(this.redis, this, index);
  }
}
