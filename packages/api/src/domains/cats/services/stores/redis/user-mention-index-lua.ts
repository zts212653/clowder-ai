/** Message-owned projection: refs only, TTL=0. The request body remains in the canonical message hash. */
export const USER_MENTION_INDEX_LUA = `
local function mentionKeys(hash)
  local row = redis.call('HMGET', hash, 'id', 'userId', 'threadId')
  if not row[1] or not row[2] or not row[3] then return nil end
  local prefix = string.sub(hash, 1, #hash - #row[1] - 4)
  return {prefix .. 'msg:user-requests:latest:' .. row[2], prefix .. 'msg:user-requests:pending:' .. row[2],
    prefix .. 'msg:user-requests:closed:' .. row[2], prefix .. 'msg:user-request-signals:' .. row[2] .. ':' .. row[3]}
end
local function mentionAux(keys, kind)
  return (string.gsub(keys[1], 'msg:user%-requests:latest:', 'msg:user-requests:' .. kind .. ':', 1))
end
local function mentionPrefix(hash, id)
  return string.sub(hash, 1, #hash - #id - 4)
end
local function mentionPosition(prefix, thread, id)
  local score = redis.call('ZSCORE', prefix .. 'msg:visibility:' .. thread, id)
  if score then return tonumber(score) end
  if redis.call('HGET', prefix .. 'msg:visibility-meta:' .. thread, 'migrated') then return nil end
  local rank = redis.call('ZRANK', prefix .. 'msg:thread:' .. thread, id)
  if rank then return rank + 1 end
  return nil
end
local function compareMentionVisibility(prefix, thread, left, right)
  if left == right then return 0 end
  local leftPosition = mentionPosition(prefix, thread, left)
  local rightPosition = mentionPosition(prefix, thread, right)
  if not leftPosition or not rightPosition then return nil end
  if leftPosition ~= rightPosition then return leftPosition < rightPosition and -1 or 1 end
  return left < right and -1 or 1
end
local function laterMentionVisibilityBoundary(prefix, thread, current, candidate)
  if not current or current == '' then return candidate end
  local comparison = compareMentionVisibility(prefix, thread, current, candidate)
  if not comparison then error('USER_MENTION_POSITION_MISSING') end
  return comparison >= 0 and current or candidate
end
local function checkMentionHistoryKeys(keys)
  if not keys then return end
  for _, kind in ipairs({'handled', 'handled-meta'}) do
    local actual = redis.call('TYPE', mentionAux(keys, kind)).ok
    if actual ~= 'none' and actual ~= 'hash' then error('USER_MENTION_INDEX_INVALID') end
  end
end
local function recordMentionHandling(keys, id, thread, reason, handledAt)
  redis.call('HSET', mentionAux(keys, 'handled'), id, thread)
  redis.call('HSET', mentionAux(keys, 'handled-meta'), id,
    cjson.encode({reason=reason, handledAt=tonumber(handledAt)}))
end
local function mentionRevision(keys, thread)
  local raw = redis.call('HGET', mentionAux(keys, 'revision'), thread)
  if not raw then return 0 end
  if not string.match(raw, '^%d+$') or (#raw > 1 and string.sub(raw,1,1) == '0') then error('USER_MENTION_REVISION_INVALID') end
  local number = tonumber(raw)
  if not number or number < 0 or number >= 9007199254740990 or number ~= math.floor(number) then error('USER_MENTION_REVISION_INVALID') end
  return number
end
local function bumpMentionRevision(keys, thread)
  return redis.call('HINCRBY', mentionAux(keys, 'revision'), thread, 1)
end
local function checkMentionKeys(keys)
  if not keys then return end
  for _, kind in ipairs({'revision', 'restored', 'handled-through'}) do
    local actual = redis.call('TYPE', mentionAux(keys, kind)).ok
    if actual ~= 'none' and actual ~= 'hash' then error('USER_MENTION_INDEX_INVALID') end
  end
  if keys[4] then
    local signalPrefix = (string.gsub(keys[1], 'msg:user%-requests:latest:', 'msg:user-request-signals:', 1)) .. ':'
    mentionRevision(keys, string.sub(keys[4], #signalPrefix + 1))
  end
  local kinds = {'hash', 'zset', 'hash', 'zset'}
  for i, key in ipairs(keys) do
    local actual = redis.call('TYPE', key).ok
    local kind = kinds[i]
    if actual ~= 'none' and actual ~= kind then error('USER_MENTION_INDEX_INVALID') end
  end
end
local function mentionEvent(hash)
  local r = redis.call('HMGET', hash, 'id', 'userId', 'threadId', 'catId', 'mentionsUser', 'visibility',
    'source', 'origin', 'extra', 'deliveryStatus', 'deletedAt', 'recall', 'timestamp', 'deliveredAt', 'from', 'lifecycle')
  if not r[1] or r[6] == 'whisper' or (r[7] and r[7] ~= '') or r[8] == 'briefing' or r[11] or r[12] then return nil end
  if r[2] == 'system' or r[2] == 'scheduler' or r[4] == 'system' then return nil end
  local extra = {}
  if r[9] and r[9] ~= '' then
    local ok, parsed = pcall(cjson.decode, r[9])
    if not ok or type(parsed) ~= 'table' then return nil end
    extra = parsed
  end
  if extra.systemKind or extra.systemInfo then return nil end
  local cat = r[4] and r[4] ~= ''
  if r[15] and r[15] ~= '' then
    local ok, sender = pcall(cjson.decode, r[15])
    if not ok or type(sender) ~= 'table' then return nil end
    if sender.kind ~= 'agent' and sender.kind ~= 'user' then return nil end
    cat = sender.kind == 'agent'
  end
  if r[10] and r[10] ~= '' and r[10] ~= 'delivered' then
    -- Match isTimelinePublished: canceling a response's outbound work does not
    -- withdraw its authored body. Ordinary canceled input remains excluded.
    local publishedResponse = false
    if r[10] == 'canceled' and r[16] and r[16] ~= '' then
      local ok, lifecycle = pcall(cjson.decode, r[16])
      publishedResponse = ok and type(lifecycle) == 'table' and lifecycle.kind == 'response'
    end
    if not publishedResponse and (r[10] ~= 'queued' or not cat) then return nil end
  end
  if not cat and extra.crossPost then return nil end
  if cat and r[5] ~= '1' then return nil end
  local prefix = mentionPrefix(hash, r[1])
  local position = mentionPosition(prefix, r[3], r[1])
  if not position then return nil end
  return cat and 'request' or 'reply', r[1], r[3], r[2], tonumber(r[14] or r[13]) or 0, position
end
local function mentionCandidatePosition(keys, prefix, expectedOwner, thread, id)
  local kind, _, candidateThread, owner, _, position = mentionEvent(prefix .. 'msg:' .. id)
  if kind ~= 'request' or candidateThread ~= thread or owner ~= expectedOwner then return nil end
  local restored = redis.call('HGET', mentionAux(keys, 'restored'), thread)
  if restored == id then return position end
  local replyClosed = redis.call('HGET', keys[3], thread) or ''
  if id <= replyClosed then return nil end
  local handledThrough = redis.call('HGET', mentionAux(keys, 'handled-through'), thread)
  if handledThrough then
    local comparison = compareMentionVisibility(prefix, thread, id, handledThrough)
    if not comparison or comparison <= 0 then return nil end
  end
  return position
end
local function addMentionSignal(signals, id)
  -- Keep scores equal so pre-upgrade Z*BYLEX readers remain correct during rollback or mixed-version operation.
  redis.call('ZADD', signals, 0, id)
end
local function latestMentionCandidate(keys, prefix, expectedOwner, thread)
  local latestId = nil
  local latestPosition = nil
  for _, candidate in ipairs(redis.call('ZRANGE', keys[4], 0, -1)) do
    local position = mentionCandidatePosition(keys, prefix, expectedOwner, thread, candidate)
    if not position then
      redis.call('ZREM', keys[4], candidate)
    else
      addMentionSignal(keys[4], candidate)
      if not latestPosition or position > latestPosition or (position == latestPosition and candidate > latestId) then
        latestId = candidate
        latestPosition = position
      end
    end
  end
  return latestId
end
local function reconcileMentionState(keys, prefix, expectedOwner, thread, fallbackId)
  local latest = latestMentionCandidate(keys, prefix, expectedOwner, thread)
  if latest then
    redis.call('HSET', keys[1], thread, latest)
    redis.call('ZADD', keys[2], 0, thread)
  else
    redis.call('ZREM', keys[2], thread)
    if fallbackId and fallbackId ~= '' then redis.call('HSET', keys[1], thread, fallbackId)
    else redis.call('HDEL', keys[1], thread) end
  end
  return latest
end
local function removeMentionSignalsThroughReply(keys, boundaryId)
  for _, candidate in ipairs(redis.call('ZRANGE', keys[4], 0, -1)) do
    if candidate <= boundaryId then redis.call('ZREM', keys[4], candidate) end
  end
end
local function removeMentionSignalsThroughVisibility(keys, prefix, thread, boundaryId)
  local boundaryPosition = mentionPosition(prefix, thread, boundaryId)
  if not boundaryPosition then error('USER_MENTION_POSITION_MISSING') end
  for _, candidate in ipairs(redis.call('ZRANGE', keys[4], 0, -1)) do
    local position = mentionPosition(prefix, thread, candidate)
    if not position or position < boundaryPosition or (position == boundaryPosition and candidate <= boundaryId) then
      redis.call('ZREM', keys[4], candidate)
    else
      addMentionSignal(keys[4], candidate)
    end
  end
end
local function nextMentionHandledThrough(keys, prefix, thread, boundaryId)
  local current = redis.call('HGET', mentionAux(keys, 'handled-through'), thread)
  return laterMentionVisibilityBoundary(prefix, thread, current, boundaryId)
end
local function refreshMention(hash)
  local event, id, thread, owner, handledAt, position = mentionEvent(hash)
  if not event then return end
  local keys = mentionKeys(hash)
  checkMentionKeys(keys)
  checkMentionHistoryKeys(keys)
  local prefix = mentionPrefix(hash, id)
  if event == 'request' then
    local restored = redis.call('HGET', mentionAux(keys, 'restored'), thread)
    local replyClosed = redis.call('HGET', keys[3], thread) or ''
    local handledThrough = redis.call('HGET', mentionAux(keys, 'handled-through'), thread)
    if restored ~= id then
      if id <= replyClosed then return end
      if handledThrough then
        local comparison = compareMentionVisibility(prefix, thread, id, handledThrough)
        if not comparison or comparison <= 0 then return end
      end
    end
    if not redis.call('ZSCORE', keys[4], id) then bumpMentionRevision(keys, thread) end
    addMentionSignal(keys[4], id)
    local previous = redis.call('HGET', keys[1], thread)
    local previousPending = redis.call('ZSCORE', keys[2], thread)
    local comparison = previous and compareMentionVisibility(prefix, thread, id, previous) or nil
    if not previousPending or not previous or not comparison or comparison > 0 then
      redis.call('HSET', keys[1], thread, id)
    end
    redis.call('ZADD', keys[2], 0, thread)
  else
    local repliedRequest = nil
    for _, candidate in ipairs(redis.call('ZRANGE', keys[4], 0, -1)) do
      local candidatePosition = mentionCandidatePosition(keys, prefix, owner, thread, candidate)
      if not candidatePosition then
        redis.call('ZREM', keys[4], candidate)
      elseif candidate <= id and (not repliedRequest or candidate > repliedRequest) then
        repliedRequest = candidate
      end
    end
    if repliedRequest then recordMentionHandling(keys, repliedRequest, thread, 'replied', handledAt) end
    local previousClosed = redis.call('HGET', keys[3], thread) or ''
    local nextClosed = previousClosed > id and previousClosed or id
    local changed = nextClosed ~= previousClosed
    redis.call('HSET', keys[3], thread, nextClosed)
    redis.call('HDEL', mentionAux(keys, 'restored'), thread)
    removeMentionSignalsThroughReply(keys, nextClosed)
    if changed or repliedRequest then bumpMentionRevision(keys, thread) end
    reconcileMentionState(keys, prefix, owner, thread, nextClosed)
  end
end
`;

/** Shares the canonical write's linearization point, including frontier append and metadata replacement. */
export function withUserMentionIndex(script: string, hashKey = 1, newKeysExpression?: string): string {
  return `${USER_MENTION_INDEX_LUA}
local preMentionKeys = mentionKeys(KEYS[${hashKey}])${newKeysExpression ? ` or ${newKeysExpression}` : ''}
checkMentionKeys(preMentionKeys)
checkMentionHistoryKeys(preMentionKeys)
local mentionResult = (function()
${script}
end)()
refreshMention(KEYS[${hashKey}])
return mentionResult
`;
}

/** Migrate persisted flags in bounded Lua batches so long-lived owners never hit a history-size cliff. */
export const READ_USER_MENTIONS_LUA = `${USER_MENTION_INDEX_LUA}
checkMentionKeys({KEYS[2], KEYS[3], KEYS[5]})
checkMentionHistoryKeys({KEYS[2]})
local version = redis.call('GET', KEYS[4])
if version ~= '1' then
  -- If deletion removed the saved cursor, restart safely: refresh is idempotent
  -- and cannot reopen resolved rows or overwrite newer append-owned signals.
  local offset = 0
  if version then
    if string.sub(version, 1, 7) ~= 'cursor:' then return redis.error_reply('USER_MENTION_INDEX_VERSION_INVALID') end
    local rank = redis.call('ZRANK', KEYS[1], string.sub(version, 8))
    if rank then offset = rank + 1 end
  end
  local batch = redis.call('ZRANGE', KEYS[1], offset, offset + 999)
  for _, id in ipairs(batch) do refreshMention(ARGV[1] .. 'msg:' .. id) end
  if #batch == 1000 then
    redis.call('SET', KEYS[4], 'cursor:' .. batch[#batch])
    return {'more'}
  end
  redis.call('SET', KEYS[4], '1')
end
local ids = {'complete'}
for _, thread in ipairs(redis.call('ZRANGE', KEYS[3], 0, -1)) do
  local signals = ARGV[1] .. 'msg:user-request-signals:' .. ARGV[2] .. ':' .. thread
  local keys = {KEYS[2], KEYS[3], KEYS[5], signals}
  checkMentionKeys(keys)
  local id = latestMentionCandidate(keys, ARGV[1], ARGV[2], thread)
  if id then
    redis.call('HSET', KEYS[2], thread, id)
    table.insert(ids, id)
  else
    redis.call('ZREM', KEYS[3], thread)
    local fallback = redis.call('HGET', mentionAux(keys, 'handled-through'), thread) or
      redis.call('HGET', KEYS[5], thread)
    if fallback then redis.call('HSET', KEYS[2], thread, fallback) else redis.call('HDEL', KEYS[2], thread) end
  end
end
return ids
`;

export const RESOLVE_USER_MENTION_LUA = `${USER_MENTION_INDEX_LUA}
checkMentionKeys({KEYS[1],KEYS[2],KEYS[3],KEYS[4]})
checkMentionHistoryKeys(KEYS)
local kind, id, thread, owner = mentionEvent(KEYS[6])
if kind ~= 'request' or id ~= ARGV[2] or thread ~= ARGV[1] or owner ~= ARGV[4] then return 0 end
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
local revision = mentionRevision(KEYS, ARGV[1])
local restored = redis.call('HGET', mentionAux(KEYS, 'restored'), ARGV[1])
if (ARGV[3] ~= '' and tonumber(ARGV[3]) ~= revision) or (ARGV[3] == '' and restored) then return 0 end
local replyClosed = redis.call('HGET', KEYS[3], ARGV[1]) or ''
for _, candidate in ipairs(redis.call('ZRANGE',KEYS[4],0,-1)) do
  if candidate > replyClosed then replyClosed = candidate end
end
if id > replyClosed then replyClosed = id end
local removed = redis.call('ZREM', KEYS[2], ARGV[1])
if removed == 1 then
  recordMentionHandling(KEYS,ARGV[2],ARGV[1],'ignored',ARGV[5])
  redis.call('HSET', KEYS[3], ARGV[1], replyClosed)
  redis.call('HDEL', mentionAux(KEYS, 'restored'), ARGV[1])
  bumpMentionRevision(KEYS, ARGV[1])
  redis.call('DEL',KEYS[4])
  redis.call('HSET',KEYS[1],ARGV[1],id)
end
return removed
`;

/** Exact visibility-bound read: close only the current request at/before the durable target. */
export const RESOLVE_USER_MENTION_FROM_READ_LUA = `${USER_MENTION_INDEX_LUA}
checkMentionKeys({KEYS[1],KEYS[2],KEYS[3],KEYS[4]})
checkMentionHistoryKeys(KEYS)
if redis.call('HGET',KEYS[7],'threadId') ~= ARGV[1] then return 0 end
local targetScore=redis.call('ZSCORE',KEYS[8],ARGV[4])
if not targetScore then return 0 end
reconcileMentionState(KEYS,ARGV[2],ARGV[3],ARGV[1],'')
if not redis.call('ZSCORE',KEYS[2],ARGV[1]) then return 0 end
local id=redis.call('HGET',KEYS[1],ARGV[1])
if not id then return 0 end
local kind,sourceId,thread,owner=mentionEvent(ARGV[2] .. 'msg:' .. id)
if kind ~= 'request' or sourceId ~= id or thread ~= ARGV[1] or owner ~= ARGV[3] then return 0 end
local sourceScore=redis.call('ZSCORE',KEYS[8],id)
if not sourceScore then return 0 end
sourceScore=tonumber(sourceScore)
targetScore=tonumber(targetScore)
if sourceScore > targetScore or (sourceScore == targetScore and id > ARGV[4]) then return 0 end
if redis.call('HGET',KEYS[1],ARGV[1]) ~= id or not redis.call('ZSCORE',KEYS[2],ARGV[1]) then return 0 end
local handledThrough=nextMentionHandledThrough(KEYS,ARGV[2],ARGV[1],ARGV[4])
redis.call('HSET',mentionAux(KEYS,'handled-through'),ARGV[1],handledThrough)
recordMentionHandling(KEYS,id,ARGV[1],'viewed',ARGV[5])
redis.call('HDEL',mentionAux(KEYS,'restored'),ARGV[1])
bumpMentionRevision(KEYS,ARGV[1])
removeMentionSignalsThroughVisibility(KEYS,ARGV[2],ARGV[1],handledThrough)
reconcileMentionState(KEYS,ARGV[2],ARGV[3],ARGV[1],'')
return 1
`;
