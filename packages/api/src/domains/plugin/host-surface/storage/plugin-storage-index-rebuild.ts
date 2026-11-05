import { randomUUID } from 'node:crypto';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { PluginPrivateStorageIndex } from './PluginPrivateStorageIndex.js';
import { pluginStorageIndexState, pluginStorageRecord } from './plugin-storage-index-contract.js';
import { STORAGE_INDEX_PREFLIGHT } from './plugin-storage-index-lua.js';

const BEGIN = `${STORAGE_INDEX_PREFLIGHT}
local raw = redis.call('HGET', KEYS[2], ARGV[1])
if (raw or '') ~= ARGV[2] then return 0 end
if not raw and redis.call('HLEN', KEYS[2]) >= 8 then return redis.error_reply('plugin_storage_index_limit') end
local state = {token=ARGV[3], status='building', cursor='0', count=0}
if raw then state.previousToken = cjson.decode(raw).token end
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(state))
return 1`;
const PROJECT = `${STORAGE_INDEX_PREFLIGHT}
local rawState = redis.call('HGET', KEYS[2], ARGV[1])
if not rawState then return 0 end
local state = cjson.decode(rawState)
if state.token ~= ARGV[2] or state.status ~= 'building' then return 0 end
if redis.call('HGET', KEYS[1], ARGV[3]) ~= ARGV[4] then return 0 end
if ARGV[5] == '' then redis.call('ZREM', KEYS[3], ARGV[3])
else redis.call('ZADD', KEYS[3], ARGV[5], ARGV[3]) end
state.count = redis.call('ZCARD', KEYS[3])
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(state))
return 1`;
const ADVANCE = `${STORAGE_INDEX_PREFLIGHT}
local state = cjson.decode(redis.call('HGET', KEYS[2], ARGV[1]))
if state.token ~= ARGV[2] or state.status ~= 'building' or state.cursor ~= ARGV[3] then return 0 end
state.cursor = ARGV[4]; state.count = redis.call('ZCARD', KEYS[3])
if ARGV[4] == '0' then state.status = 'ready' end
redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(state))
return 1`;

/** Explicit, resumable source census. Periodic due reads never call it. New writes/deletes target the same fenced build generation. */
export async function rebuildPluginStorageIndex(
  redis: RedisClient,
  owner: PluginPrivateStorageIndex,
  index: string,
): Promise<{ status: 'ready'; version: string }> {
  let started = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = await redis.hget(owner.catalog, index),
      state = pluginStorageIndexState(raw);
    if (state?.status === 'building') {
      started = true;
      break;
    }
    const token = randomUUID();
    if (
      Number(
        await redis.eval(BEGIN, 3, owner.hash, owner.catalog, owner.indexKey(index, token), index, raw ?? '', token),
      ) === 1
    ) {
      started = true;
      break;
    }
  }
  if (!started) throw new Error('plugin storage rebuild raced; retry current index');
  for (;;) {
    const state = pluginStorageIndexState(await redis.hget(owner.catalog, index));
    if (!state) throw new Error('plugin storage index rebuild lost its version');
    if (state.status === 'ready') {
      if (state.previousToken) await redis.del(owner.indexKey(index, state.previousToken)); // Derived index only, never source history.
      return { status: 'ready', version: state.token };
    }
    if (state.status !== 'building') throw new Error('plugin storage index rebuild is not ready');
    const [cursor, fields] = await redis.hscan(owner.hash, state.cursor, 'COUNT', 100);
    for (let i = 0; i < fields.length; i += 2) {
      const key = fields[i]!,
        raw = fields[i + 1]!;
      if (!key || !/^\d+:i:/.test(raw)) continue;
      const projection = pluginStorageRecord(raw).projection;
      if (projection?.index !== index) continue;
      await redis.eval(
        PROJECT,
        3,
        owner.hash,
        owner.catalog,
        owner.indexKey(index, state.token),
        index,
        state.token,
        key,
        raw,
        projection.score ?? '',
      );
    }
    await redis.eval(
      ADVANCE,
      3,
      owner.hash,
      owner.catalog,
      owner.indexKey(index, state.token),
      index,
      state.token,
      state.cursor,
      cursor,
    );
  }
}
