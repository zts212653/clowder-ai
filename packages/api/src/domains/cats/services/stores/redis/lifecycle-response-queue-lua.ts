import { QUEUE_ADMISSION_VERDICT_LUA } from '../../agents/invocation/queue-ledger/queue-ledger-redis-admission-scripts.js';

/** D10: publish one response and all exact caller controls, across threads, in one Redis transaction. */
export const COMMIT_LIFECYCLE_RESPONSE_WITH_LEDGER_LUA = `${QUEUE_ADMISSION_VERDICT_LUA}
local messageKey = KEYS[1]
local messageId = redis.call('HGET', messageKey, 'id')
if not messageId then return -1 end
if redis.call('HGET', messageKey, 'recall') or redis.call('HGET', messageKey, '_tombstone') then return -2 end
local existingLifecycleRaw = redis.call('HGET', messageKey, 'lifecycle')
if not existingLifecycleRaw or existingLifecycleRaw == '' then return -2 end
local lifecycleOk, existingLifecycle = pcall(cjson.decode, existingLifecycleRaw)
if not lifecycleOk or type(existingLifecycle) ~= 'table' or existingLifecycle.kind ~= 'response' then return -2 end
if existingLifecycle.invocationId ~= ARGV[1] then return -3 end

local maxUserSources = tonumber(ARGV[16])
local count = tonumber(ARGV[17])
if not count or count < 1 then return redis.error_reply('QUEUE_ADMISSION_EMPTY') end
local incoming = {}
local incomingIds = {}
local incomingUserSources = {}
local ledgerNeedsWrite = false
local responseThreadId = redis.call('HGET', messageKey, 'threadId')
for i = 1, count do
  local raw = ARGV[17 + i]
  local row = cjson.decode(raw)
  local keyOffset = 6 + (i - 1) * 4
  local rowsKey = KEYS[keyOffset + 1]
  local orderKey = KEYS[keyOffset + 2]
  local messageIndexKey = KEYS[keyOffset + 3]
  local privateAdmissionsKey = KEYS[keyOffset + 4]
  local fingerprint = ARGV[17 + count * 2 + i]
  local private = row.kind == 'private_input'
  local bound = row.threadId == responseThreadId and row.payload and
    row.payload.sourceRecordId == messageId and row.payload.messageId == messageId
  local prefix = 'cross-thread-failure:' .. messageId .. ':'
  local failureReturn = private and row.sourceCategory == 'a2a_failure' and
    row.from and row.from.kind == 'system' and row.from.service == 'message_delivery' and
    row.threadId ~= responseThreadId and row.payload and not row.payload.messageId and
    string.sub(row.payload.sourceRecordId, 1, #prefix) == prefix and
    cjson.decode(ARGV[2]).status == 'failed'
  if row.status ~= 'queued' or not (bound or failureReturn) then
    return redis.error_reply('QUEUE_ADMISSION_INVALID_ROW')
  end
  if incomingIds[row.id] then return redis.error_reply('QUEUE_ADMISSION_DUPLICATE_ID') end
  incomingIds[row.id] = true
  local currentRaw = redis.call('HGET', rowsKey, row.id)
  if (currentRaw or '') ~= ARGV[17 + count + i] then return -10 end
  local verdict = queueAdmissionVerdict(rowsKey, privateAdmissionsKey, row, fingerprint)
  if verdict == 'conflict' then return -5 end
  local fresh = verdict == 'fresh'
  if fresh and not private and redis.call('HEXISTS', messageIndexKey, messageId) == 1 then return -10 end
  incoming[i] = { id = row.id, raw = raw, private = private, fingerprint = fingerprint,
    rowsKey = rowsKey, orderKey = orderKey, messageIndexKey = messageIndexKey,
    privateAdmissionsKey = privateAdmissionsKey, fresh = fresh }
  if fresh then ledgerNeedsWrite = true end
  if fresh and row.from and row.from.kind == 'user' then incomingUserSources[row.payload.sourceRecordId] = true end
end

if ledgerNeedsWrite and maxUserSources and maxUserSources >= 0 then
  local queuedUserSources = {}
  local activeIds = redis.call('LRANGE', KEYS[3], 0, -1)
  for i = 1, #activeIds do
    local currentRaw = redis.call('HGET', KEYS[2], activeIds[i])
    if not currentRaw then return redis.error_reply('QUEUE_ORDER_ROW_MISSING') end
    local row = cjson.decode(currentRaw)
    if row.status == 'queued' and row.from and row.from.kind == 'user' then
      queuedUserSources[row.payload.sourceRecordId] = true
    end
  end
  for sourceId, _ in pairs(incomingUserSources) do queuedUserSources[sourceId] = true end
  local queuedUserCount = 0
  for _, _ in pairs(queuedUserSources) do queuedUserCount = queuedUserCount + 1 end
  if queuedUserCount > maxUserSources then return 0 end
end

local function sameField(field, expected)
  local actual = redis.call('HGET', messageKey, field)
  if actual == false then actual = '' end
  return actual == expected
end

local lifecycleNeedsWrite = false
if existingLifecycle.status == 'processing' then
  if existingLifecycleRaw ~= ARGV[14] or not sameField('extra', ARGV[15]) then return -10 end
  lifecycleNeedsWrite = true
elseif not (existingLifecycleRaw == ARGV[2] and
     sameField('content', ARGV[3]) and
     sameField('contentBlocks', ARGV[4]) and
     sameField('toolEvents', ARGV[5]) and
     sameField('metadata', ARGV[6]) and
     sameField('extra', ARGV[7]) and
     sameField('thinking', ARGV[8]) and
     sameField('origin', ARGV[9]) and
     sameField('mentions', ARGV[10]) and
     sameField('mentionsUser', ARGV[11]) and
     sameField('replyTo', ARGV[12]) and
     sameField('pluginMessage', ARGV[13])) then
  return -4
end

-- Validate terminal-response publication before the first Message or Queue
-- mutation. Processing placeholders have no cursor position until this commit.
local visibilitySeq = nil
local existingVisibility = redis.call('HGET', messageKey, 'visibilitySeq')
if not existingVisibility or existingVisibility == '' then
  local hwmRaw = redis.call('HGET', KEYS[6], 'hwm')
  local hwm = 0
  if hwmRaw ~= false then
    hwm = tonumber(hwmRaw)
    if hwm == nil or hwm ~= hwm or hwm ~= math.floor(hwm) or hwm < 0 then
      return redis.error_reply('VISIBILITY_HWM_INVALID: raw=' .. tostring(hwmRaw))
    end
  end
  local timeArr = redis.call('TIME')
  local nowMs = tonumber(timeArr[1]) * 1000 + math.floor(tonumber(timeArr[2]) / 1000)
  visibilitySeq = math.max(hwm + 1, nowMs)
  if visibilitySeq > 9007199254730991 then
    return redis.error_reply('VISIBILITY_SEQ_EXHAUSTED: seq=' .. tostring(visibilitySeq))
  end
end

if lifecycleNeedsWrite then
  redis.call('HSET', messageKey, 'lifecycle', ARGV[2], 'content', ARGV[3], 'mentions', ARGV[10])
  local function replaceOptional(field, value)
    if value == '' then redis.call('HDEL', messageKey, field)
    else redis.call('HSET', messageKey, field, value) end
  end
  replaceOptional('contentBlocks', ARGV[4])
  replaceOptional('toolEvents', ARGV[5])
  replaceOptional('metadata', ARGV[6])
  replaceOptional('extra', ARGV[7])
  replaceOptional('thinking', ARGV[8])
  replaceOptional('origin', ARGV[9])
  replaceOptional('mentionsUser', ARGV[11])
  replaceOptional('replyTo', ARGV[12])
  replaceOptional('pluginMessage', ARGV[13])
end
if visibilitySeq then
  redis.call('ZADD', KEYS[5], visibilitySeq, messageId)
  redis.call('HSET', KEYS[6], 'hwm', tostring(visibilitySeq))
  redis.call('HSET', messageKey, 'visibilitySeq', tostring(visibilitySeq))
end

-- Every response, per-thread row and immutable private receipt is validated before any write.
for i = 1, count do
  local entry = incoming[i]
  if entry.fresh then
    redis.call('HSET', entry.rowsKey, entry.id, entry.raw)
    redis.call('RPUSH', entry.orderKey, entry.id)
    if entry.private then
      redis.call('HSET', entry.privateAdmissionsKey, entry.id, entry.fingerprint)
    else
      redis.call('HSET', entry.messageIndexKey, messageId, cjson.encode({ entry.id }))
    end
  end
end
if lifecycleNeedsWrite and ledgerNeedsWrite then return 1 end
if not lifecycleNeedsWrite and not ledgerNeedsWrite then return 2 end
if not lifecycleNeedsWrite and ledgerNeedsWrite then return 3 end
return 4
`;
