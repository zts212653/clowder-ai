import { randomUUID } from 'node:crypto';
import { parseWatcherSessionState, type SessionRecord } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { type WatcherRolloverInput, watcherSuccessorState } from '../ports/watcher-session-rollover.js';
import { SessionChainKeys as keys } from '../redis-keys/session-chain-keys.js';

// All validation precedes writes. Old CLI/pin history and ordinary home indexes remain untouched.
const ROLLOVER = `
local prior = redis.call('HGET', KEYS[1], 'watcherRetirement')
if not prior then return '' end
local op = cjson.decode(prior)
if op.id ~= ARGV[1] then return '' end
if op.phase == 'retired' then return op.successorSessionId or '' end
local stateRaw = redis.call('HGET', KEYS[1], 'watcherState')
if not stateRaw then return '' end
local state = cjson.decode(stateRaw)
if state.revision ~= tonumber(ARGV[2]) then return '' end
if redis.call('HGET', KEYS[1], 'sessionPurpose') ~= 'watcher'
  or redis.call('HGET', KEYS[1], 'status') ~= 'active'
  or redis.call('GET', KEYS[4]) ~= ARGV[3]
  or op.phase ~= 'idle' or state.attempt or state.wakeInvocationId
  or state.toolSchemaHash ~= op.oldSchemaHash
  or (redis.call('HGET', KEYS[1], 'cliSessionId') or '') ~= ARGV[4]
  or (op.nativeCliSessionId or '') ~= ARGV[4]
  or (redis.call('HGET', KEYS[1], 'nativeSessionBinding') or '') ~= ARGV[5]
  or redis.call('HGET', KEYS[1], 'userId') ~= ARGV[8]
  or redis.call('HGET', KEYS[1], 'catId') ~= ARGV[9]
  or redis.call('HGET', KEYS[1], 'threadId') ~= ARGV[10]
  or redis.call('HGET', KEYS[1], 'chainKey') ~= ARGV[11]
  or redis.call('EXISTS', KEYS[2]) ~= 0 then return '' end
local pendingKind = redis.call('TYPE', KEYS[5]).ok
if pendingKind ~= 'none' and pendingKind ~= 'set' then return redis.error_reply('invalid_watcher_pending_index') end
local seq = 0
local prefix = string.sub(KEYS[1], 1, string.len(KEYS[1]) - string.len(ARGV[3]))
for _, id in ipairs(redis.call('ZRANGE', KEYS[3], 0, -1)) do
  if redis.call('HGET', prefix .. id, 'userId') == ARGV[8]
    and redis.call('HGET', prefix .. id, 'sessionPurpose') == 'watcher' then seq = seq + 1 end
end
redis.call('HSET', KEYS[2], 'id', ARGV[6], 'userId', ARGV[8], 'catId', ARGV[9],
  'threadId', ARGV[10], 'chainKey', ARGV[11], 'sessionPurpose', 'watcher', 'status', 'active',
  'seq', tostring(seq), 'messageCount', '0', 'createdAt', ARGV[7], 'updatedAt', ARGV[7],
  'watcherState', ARGV[12])
for _, field in ipairs({'workingDirectory', 'workspaceFingerprint'}) do
  local value = redis.call('HGET', KEYS[1], field)
  if value then redis.call('HSET', KEYS[2], field, value) end
end
state.revision = state.revision + 1
op.phase = 'retired'
op.successorSessionId = ARGV[6]
redis.call('HSET', KEYS[1], 'status', 'sealed', 'sealReason', 'watcher_native_tool_surface_changed',
  'sealedAt', ARGV[7], 'updatedAt', ARGV[7], 'watcherState', ARGV[13],
  'watcherRetirement', cjson.encode(op))
redis.call('ZADD', KEYS[3], seq, ARGV[6])
redis.call('SET', KEYS[4], ARGV[6])
redis.call('SREM', KEYS[5], ARGV[3])
return ARGV[6]
`;

export async function rolloverRedisWatcher(
  redis: RedisClient,
  old: SessionRecord,
  input: WatcherRolloverInput,
): Promise<string | null> {
  if (old.sessionPurpose !== 'watcher' || !old.chainKey) return null;
  if (old.watcherRetirement?.id !== input.retirementId) return null;
  // Idempotent replay does not allocate another successor or move its active pointer backwards.
  if (old.watcherRetirement.phase === 'retired') return old.watcherRetirement.successorSessionId ?? null;
  const state = parseWatcherSessionState(old.watcherState);
  if (state.revision !== input.expectedRevision) return null;
  const id = randomUUID();
  const result = await redis.eval(
    ROLLOVER,
    5,
    keys.detail(old.id),
    keys.detail(id),
    keys.chain(old.catId, old.threadId),
    keys.byChainKey(old.chainKey),
    keys.watcherPending(old.userId),
    input.retirementId,
    String(input.expectedRevision),
    old.id,
    input.expectedCliSessionId ?? '',
    input.expectedNativeSessionBinding ? JSON.stringify(input.expectedNativeSessionBinding) : '',
    id,
    String(Date.now()),
    old.userId,
    old.catId,
    old.threadId,
    old.chainKey,
    JSON.stringify(watcherSuccessorState(state)),
    JSON.stringify({ ...state, revision: state.revision + 1 }),
  );
  return typeof result === 'string' && result ? result : null;
}
