/** Every lease writer uses this same owner/index commit point. Private recovery never replaces custody truth. */
export const ACTION_SUCCESSOR_RECOVERY_LUA = `
local recoveryLanes = {'return', 'dispatch', 'task'}
local function assertRecoveryIndexTypes(keys)
  for _, key in ipairs(keys) do
    local kind = redis.call('TYPE', key)
    if type(kind) == 'table' then kind = kind.ok end
    if kind ~= 'none' and kind ~= 'zset' then error('action_recovery_index_wrong_type') end
  end
end
local function assertActionAllType(key)
  local kind = redis.call('TYPE',key)
  if type(kind) == 'table' then kind = kind.ok end
  if kind ~= 'none' and kind ~= 'set' then error('action_all_index_wrong_type') end
end
local function recoveryRevision(value)
  local n = tonumber(value)
  if not n or n < 0 or n % 1 ~= 0 then return 0 end
  return n
end
local function validRecoveryFact(fact, generation)
  if type(fact) ~= 'table' or fact.v ~= 1 or fact.generation ~= generation or
    type(fact.attempts) ~= 'number' or fact.attempts < 0 or fact.attempts % 1 ~= 0 then return false end
  if fact.nextAttemptAt ~= cjson.null and (type(fact.nextAttemptAt) ~= 'number' or fact.nextAttemptAt < 0) then return false end
  if fact.claim ~= nil and (type(fact.claim) ~= 'table' or type(fact.claim.token) ~= 'string' or type(fact.claim.expiresAt) ~= 'number') then return false end
  if fact.notification ~= nil and (type(fact.notification) ~= 'table' or type(fact.notification.key) ~= 'string' or
    type(fact.notification.reasonCode) ~= 'string' or type(fact.notification.attempts) ~= 'number') then return false end
  return true
end
local function actionRecoveryActive(record, lane)
  if record.status == 'completed' then return false end
  if lane == 'return' then
    return (record.returnDeliveryState == 'pending' or record.returnDeliveryState == 'overdue') and
      (record.actionFamily ~= 'review' or (record.dispatchDeliveryState == 'delivered' and
       type(record.dispatchDeliveredMessageId) == 'string' and record.dispatchDeliveredMessageId ~= ''))
  end
  if lane == 'dispatch' then return record.dispatchDeliveryState == 'pending' end
  return record.status == 'active' and record.actionFamily == 'implement' and
    record.successorSlot == 'implementer' and type(record.subjectRef) == 'string' and
    string.sub(record.subjectRef,1,13) == 'subject:task:' and type(record.terminalPredicate) == 'table' and
    record.terminalPredicate.kind == 'task_done'
end
-- Preserve business JSON byte-for-byte. Redis cjson turns empty arrays into objects, so only
-- encode private metadata; split root fields without decoding nested business values.
local function encodeRecoveryMetadata(raw, candidate)
  local fields, depth, quoted, escaped, start, nameStart, name = {}, 0, false, false, 2, nil, nil
  local function keepField(stop)
    if name and name ~= '_recovery' and name ~= '_recoveryRevision' then
      table.insert(fields,string.sub(raw,start,stop))
    end
    name = nil
  end
  for i=1,string.len(raw) do
    local ch = string.sub(raw,i,i)
    if quoted then
      if escaped then escaped = false
      elseif string.byte(ch) == 92 then escaped = true
      elseif ch == '"' then
        quoted = false
        if nameStart then name = cjson.decode(string.sub(raw,nameStart,i)); nameStart = nil end
      end
    elseif ch == '"' then
      quoted = true
      if depth == 1 and not name then nameStart = i end
    elseif ch == '{' or ch == '[' then
      depth = depth + 1
    elseif ch == '}' or ch == ']' then
      if depth == 1 then keepField(i-1) end
      depth = depth - 1
    elseif ch == ',' and depth == 1 then
      keepField(i-1); start = i+1
    end
  end
  table.insert(fields,'"_recovery":'..cjson.encode(candidate._recovery))
  table.insert(fields,'"_recoveryRevision":'..candidate._recoveryRevision)
  return '{'..table.concat(fields,',')..'}'
end
local function saveActionRecoveryOwner(detail, candidate, previous, indexes, preserve, raw)
  if preserve and previous and previous.leaseId == candidate.leaseId and previous.generation == candidate.generation then
    candidate._recovery = previous._recovery
    candidate._recoveryRevision = previous._recoveryRevision
  end
  local existingRecovery = candidate._recovery ~= nil
  if type(candidate._recovery) ~= 'table' then candidate._recovery = {} end
  candidate._recoveryRevision = recoveryRevision(candidate._recoveryRevision)
  for i, lane in ipairs(recoveryLanes) do
    local fact = candidate._recovery[lane]
    if fact == nil and not existingRecovery then
      fact = {v=1,generation=candidate.generation,attempts=0,nextAttemptAt=0}
    elseif not validRecoveryFact(fact,candidate.generation) then
      fact = {v=1,generation=candidate.generation,attempts=5,nextAttemptAt=0,
        disposition='needs_attention',reasonCode='malformed_recovery_fact',
        notification={key='action-recovery:'..candidate.leaseId..':'..candidate.generation..':owner:malformed_recovery_fact',
          reasonCode='malformed_recovery_fact',attempts=0}}
    elseif previous and previous.generation == candidate.generation and
      not actionRecoveryActive(previous,lane) and actionRecoveryActive(candidate,lane) and not fact.disposition then
      fact.nextAttemptAt = 0
    end
    local pendingNotice = type(fact.notification) == 'table' and not fact.notification.deliveredAt and
      (tonumber(fact.notification.attempts) or 0) < 5
    if not actionRecoveryActive(candidate,lane) and not pendingNotice then
      fact.nextAttemptAt = cjson.null
      fact.claim = nil
    elseif fact.disposition and not pendingNotice then fact.nextAttemptAt = cjson.null end
    candidate._recovery[lane] = fact
    if type(fact.nextAttemptAt) == 'number' then redis.call('ZADD',indexes[i],fact.nextAttemptAt,detail)
    else redis.call('ZREM',indexes[i],detail) end
  end
  local encoded = encodeRecoveryMetadata(raw,candidate)
  redis.call('SET',detail,encoded)
  return encoded
end
`;

/** A classification CAS preserves all original business fields; malformed raw bytes have a named envelope. */
export const CLASSIFY_ACTION_RECOVERY_LUA = `${ACTION_SUCCESSOR_RECOVERY_LUA}
assertRecoveryIndexTypes({KEYS[2],KEYS[3],KEYS[4]})
local current = redis.call('GET',KEYS[1])
if not ((not current and ARGV[3] == 'missing') or current == ARGV[1]) then return 0 end
local next = cjson.decode(ARGV[2])
if next._invalidRaw ~= nil then
  redis.call('SET',KEYS[1],ARGV[2])
  for i=2,4 do redis.call('ZREM',KEYS[i],KEYS[1]) end
else saveActionRecoveryOwner(KEYS[1],next,nil,{KEYS[2],KEYS[3],KEYS[4]},false,ARGV[2]) end
return 1
`;

/** Independent metadata revision and the original generation fence keep business writers authoritative. */
export const UPDATE_ACTION_RECOVERY_LUA = `${ACTION_SUCCESSOR_RECOVERY_LUA}
assertRecoveryIndexTypes({KEYS[3],KEYS[4],KEYS[5]})
local raw = redis.call('GET',KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current._invalidRaw ~= nil or current.generation ~= tonumber(ARGV[2]) then return 0 end
if ARGV[6] ~= '' then
  local laneFact = type(current._recovery) == 'table' and current._recovery[ARGV[1]]
  if type(laneFact) ~= 'table' or type(laneFact.claim) ~= 'table' or laneFact.claim.token ~= ARGV[6] then return 0 end
elseif recoveryRevision(current._recoveryRevision) ~= tonumber(ARGV[3]) then return 0 end
if tonumber(ARGV[4]) >= 0 and current.revision ~= tonumber(ARGV[4]) then return 0 end
local nextFact = cjson.decode(ARGV[5])
if redis.call('GET',KEYS[2]) ~= KEYS[1] and not (nextFact.disposition and not nextFact.claim) then return -2 end
if type(current._recovery) ~= 'table' then current._recovery = {} end
current._recovery[ARGV[1]] = nextFact
current._recoveryRevision = recoveryRevision(current._recoveryRevision) + 1
saveActionRecoveryOwner(KEYS[1],current,nil,{KEYS[3],KEYS[4],KEYS[5]},false,raw)
return 1
`;
