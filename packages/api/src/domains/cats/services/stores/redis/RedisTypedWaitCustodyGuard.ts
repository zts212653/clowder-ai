import type { AwaitStateV1 } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { rejectTypedWaitCustody, type TypedWaitCustodyGuard } from '../../../../ball-custody/TypedWaitCustodyGuard.js';
import {
  isLiveTypedWaitRegistration,
  parseTypedWaitRegistration,
  TYPED_WAIT_REGISTRATION_FIELD,
} from '../../../../ball-custody/TypedWaitRegistration.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { hydrateTask } from './RedisTaskCodec.js';

/** Read private proof and Task together; the Queue Lua script rechecks these fields atomically. */
export async function readRedisTypedWaitCustodyGuards(
  redis: RedisClient,
  guards: readonly TypedWaitCustodyGuard[] = [],
) {
  const keys: string[] = [];
  const witnesses: Array<{
    fields: Record<string, string>;
    expiresAt: number;
    identity: TypedWaitCustodyGuard['identity'];
    active: AwaitStateV1;
  }> = [];
  for (const guard of guards) {
    const key = TaskKeys.detail(guard.reference.taskId);
    let raw: Record<string, string>;
    try {
      raw = await redis.hgetall(key);
    } catch (error) {
      rejectTypedWaitCustody('query_failed', error);
    }
    const receipt = parseTypedWaitRegistration(raw[TYPED_WAIT_REGISTRATION_FIELD]);
    const task = raw.id ? hydrateTask(raw) : null;
    const active = task?.automationState?.await;
    if (
      !task ||
      !active ||
      !receipt ||
      !isLiveTypedWaitRegistration({ task, receipt }, guard.identity, Date.now(), guard.reference)
    ) {
      rejectTypedWaitCustody('authority_stale');
    }
    const fields: Record<string, string> = {};
    for (const field of [
      'id',
      'kind',
      'threadId',
      'userId',
      'ownerCatId',
      'status',
      'subjectKey',
      TYPED_WAIT_REGISTRATION_FIELD,
    ]) {
      fields[field] = raw[field] ?? '';
    }
    keys.push(key);
    witnesses.push({ fields, expiresAt: receipt.expiresAt, identity: guard.identity, active });
  }
  return { keys, witnesses };
}

/** Insert before ALL mutations; Redis errors do not roll back earlier script writes. */
export const ASSERT_TYPED_WAIT_CUSTODY_LUA = `
local function sameWaitJson(left, right)
  if type(left) ~= type(right) then return false end
  if type(left) ~= 'table' then return left == right end
  for key, value in pairs(left) do
    if not sameWaitJson(value, right[key]) then return false end
  end
  for key, _ in pairs(right) do if left[key] == nil then return false end end
  return true
end
local waitGuards = cjson.decode(ARGV[7])
if #waitGuards > 0 then
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local currentCustody = cjson.decode(custody)
local source = cjson.decode(redis.call('HGET', KEYS[1], 'source') or '{}')
for index, witness in ipairs(waitGuards) do
  if tonumber(witness.expiresAt) <= now then return {-3, currentRevision} end
  local okState, state = pcall(cjson.decode, redis.call('HGET', KEYS[5 + index], 'automationState') or '{}')
  if not okState or type(state) ~= 'table' or not sameWaitJson(state.await, witness.active)
    or (type(state.waitOutcome) == 'table' and state.waitOutcome.generation == witness.active.generation) then
    return {-3, currentRevision}
  end
  if messageId ~= witness.identity.sourceMessageId
    or redis.call('HGET', KEYS[1], 'threadId') ~= witness.identity.threadId
    or currentCustody.ownerUserId ~= witness.identity.userId
    or source.connector ~= 'hold-ball' or not source.meta or source.meta.wakeWhen ~= true
    or source.meta.threadId ~= witness.identity.threadId or source.meta.catId ~= witness.identity.catId
    or source.meta.taskId ~= witness.identity.holdTaskId then return {-3, currentRevision} end
  for field, value in pairs(witness.fields) do
    if (redis.call('HGET', KEYS[5 + index], field) or '') ~= value then
      return {-3, currentRevision}
    end
  end
end
end
`;
