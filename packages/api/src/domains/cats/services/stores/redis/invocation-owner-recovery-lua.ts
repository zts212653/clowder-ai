export const INVOCATION_OWNER_RECOVERY_LUA = `
local function preflightOwnerRecovery(index)
  local kind = redis.call('TYPE', index).ok
  if kind ~= 'none' and kind ~= 'zset' then error('invalid_invocation_owner_recovery_index') end
end
local function ownerScope(detail)
  return cjson.encode({redis.call('HGET', detail, 'threadId') or '', redis.call('HGET', detail, 'userId') or '',
    redis.call('HGET', detail, 'createdAt') or '', redis.call('HGET', detail, 'executionStartedAt') or ''})
end
local function ownerFacts(detail)
  local scope = ownerScope(detail)
  local raw = redis.call('HGET', detail, '_ownerRecovery')
  if raw then
    local ok, facts = pcall(cjson.decode, raw)
    if ok and type(facts) == 'table' and facts.scope == scope and type(facts.nextAt) == 'number'
      and type(facts.failures) == 'number' then return facts end
    if not ok or type(facts) ~= 'table' or facts.scope == scope then
      return {scope=scope, failures=0, nextAt=0, disposition='needs_attention', reasonCode='invalid_owner_recovery', originalRaw=raw}
    end
  end
  return {scope=scope, failures=0, nextAt=tonumber(redis.call('HGET', detail, 'createdAt')) or 0}
end
local function projectOwnerRecovery(detail, index, id, reset)
  preflightOwnerRecovery(index)
  if redis.call('HGET', detail, 'status') ~= 'running' then redis.call('ZREM', index, id); return end
  if reset then redis.call('HDEL', detail, '_ownerRecovery') end
  local facts = ownerFacts(detail)
  if redis.call('HGET', detail, 'id') ~= id then
    facts.disposition = 'needs_attention'; facts.reasonCode = 'owner_identity_mismatch'
  end
  if facts.disposition then redis.call('ZREM', index, id) else redis.call('ZADD', index, facts.nextAt, id) end
  redis.call('HSET', detail, '_ownerRecovery', cjson.encode(facts))
end
`;
