/**
 * ADR-043 queue mutations. Every script performs all validation before its
 * first write because Redis does not roll back writes made before a Lua error.
 */
export const MIGRATE_QUEUE_LEDGER_V2_LUA = `
local currentSchema = redis.call('GET', KEYS[4])
if currentSchema == '2' then return 2 end

local expectedEntries = cjson.decode(ARGV[1])
local expectedOrder = cjson.decode(ARGV[2])
local nextEntries = cjson.decode(ARGV[3])
local nextOrder = cjson.decode(ARGV[4])
local nextMessageIndex = cjson.decode(ARGV[5])
if type(expectedEntries) ~= 'table' or type(expectedOrder) ~= 'table' or
   type(nextEntries) ~= 'table' or type(nextOrder) ~= 'table' or type(nextMessageIndex) ~= 'table' then
  return redis.error_reply('QUEUE_V2_MIGRATION_INVALID')
end

local currentPairs = redis.call('HGETALL', KEYS[1])
if #currentPairs ~= #expectedEntries * 2 then return 0 end
local currentById = {}
for i = 1, #currentPairs, 2 do currentById[currentPairs[i]] = currentPairs[i + 1] end
for i = 1, #expectedEntries do
  local pair = expectedEntries[i]
  if type(pair) ~= 'table' or type(pair[1]) ~= 'string' or type(pair[2]) ~= 'string' or
     currentById[pair[1]] ~= pair[2] then return 0 end
end

local currentOrder = redis.call('LRANGE', KEYS[2], 0, -1)
if #currentOrder ~= #expectedOrder then return 0 end
for i = 1, #expectedOrder do if currentOrder[i] ~= expectedOrder[i] then return 0 end end

-- Redis does not roll back writes when a Lua script raises. Validate every
-- replacement pair before deleting the v1 hashes/lists.
for i = 1, #nextEntries do
  local pair = nextEntries[i]
  if type(pair) ~= 'table' or type(pair[1]) ~= 'string' or type(pair[2]) ~= 'string' then
    return redis.error_reply('QUEUE_V2_MIGRATION_INVALID_ENTRY')
  end
end
for i = 1, #nextOrder do
  if type(nextOrder[i]) ~= 'string' or nextOrder[i] == '' then
    return redis.error_reply('QUEUE_V2_MIGRATION_INVALID_ORDER')
  end
end
for messageId, entryIds in pairs(nextMessageIndex) do
  if type(messageId) ~= 'string' or messageId == '' or type(entryIds) ~= 'table' then
    return redis.error_reply('QUEUE_V2_MIGRATION_INVALID_MESSAGE_INDEX')
  end
  for i = 1, #entryIds do
    if type(entryIds[i]) ~= 'string' or entryIds[i] == '' then
      return redis.error_reply('QUEUE_V2_MIGRATION_INVALID_MESSAGE_INDEX')
    end
  end
end

redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
for i = 1, #nextEntries do
  local pair = nextEntries[i]
  redis.call('HSET', KEYS[1], pair[1], pair[2])
end
for i = 1, #nextOrder do redis.call('RPUSH', KEYS[2], nextOrder[i]) end
for messageId, entryIds in pairs(nextMessageIndex) do
  redis.call('HSET', KEYS[3], messageId, cjson.encode(entryIds))
end
redis.call('SET', KEYS[4], '2')
return 1
`;

export const ENQUEUE_QUEUE_ROWS_LUA = `
local rowsKey = KEYS[1]
local orderKey = KEYS[2]
local maxQueuedUsers = tonumber(ARGV[1])
local count = tonumber(ARGV[2])
if not count or count < 1 then return redis.error_reply('QUEUE_ENQUEUE_EMPTY') end

local incoming = {}
local existingCount = 0
local incomingUserSources = {}
for i = 1, count do
  local raw = ARGV[2 + i]
  local row = cjson.decode(raw)
  if not row.id or not row.threadId or row.status ~= 'queued' then
    return redis.error_reply('QUEUE_ENQUEUE_INVALID_ROW')
  end
  local existing = redis.call('HGET', rowsKey, row.id)
  if existing then
    existingCount = existingCount + 1
  end
  if row.from and row.from.kind == 'user' then incomingUserSources[row.payload.sourceRecordId] = true end
  incoming[i] = { id = row.id, raw = raw, row = row }
end
if existingCount == count then return 2 end
if existingCount ~= 0 then return -1 end

local messageIndexUpdates = {}
for i = 1, count do
  local row = incoming[i].row
  local messageId = row.payload and row.payload.messageId
  if messageId and messageId ~= '' then
    local update = messageIndexUpdates[messageId]
    if not update then
      update = { ids = {}, seen = {} }
      local existingIndexRaw = redis.call('HGET', KEYS[3], messageId)
      if existingIndexRaw then
        local decodedOk, decoded = pcall(cjson.decode, existingIndexRaw)
        if not decodedOk or type(decoded) ~= 'table' then
          return redis.error_reply('QUEUE_MESSAGE_INDEX_INVALID')
        end
        for j = 1, #decoded do
          if type(decoded[j]) ~= 'string' or decoded[j] == '' or update.seen[decoded[j]] then
            return redis.error_reply('QUEUE_MESSAGE_INDEX_INVALID')
          end
          update.seen[decoded[j]] = true
          update.ids[#update.ids + 1] = decoded[j]
        end
      end
      messageIndexUpdates[messageId] = update
    end
    if not update.seen[row.id] then
      update.seen[row.id] = true
      update.ids[#update.ids + 1] = row.id
    end
  end
end

if maxQueuedUsers and maxQueuedUsers >= 0 then
  local queuedUserSources = {}
  local activeIds = redis.call('LRANGE', orderKey, 0, -1)
  for i = 1, #activeIds do
    local currentRaw = redis.call('HGET', rowsKey, activeIds[i])
    if not currentRaw then return redis.error_reply('QUEUE_ORDER_ROW_MISSING') end
    local row = cjson.decode(currentRaw)
    if row.status == 'queued' and row.from and row.from.kind == 'user' then
      queuedUserSources[row.payload.sourceRecordId] = true
    end
  end
  for sourceId, _ in pairs(incomingUserSources) do queuedUserSources[sourceId] = true end
  local queuedUserCount = 0
  for _, _ in pairs(queuedUserSources) do queuedUserCount = queuedUserCount + 1 end
  if queuedUserCount > maxQueuedUsers then return 0 end
end

for i = 1, count do
  redis.call('HSET', rowsKey, incoming[i].id, incoming[i].raw)
  redis.call('RPUSH', orderKey, incoming[i].id)
end
for messageId, update in pairs(messageIndexUpdates) do
  redis.call('HSET', KEYS[3], messageId, cjson.encode(update.ids))
end
return 1
`;

export const EXPAND_QUEUE_TARGET_ROWS_LUA = `
local rowsKey = KEYS[1]
local anchorId = ARGV[1]
local bindTargetCatId = ARGV[2]
local expectedCount = tonumber(ARGV[3])
local count = tonumber(ARGV[4])
if not bindTargetCatId or bindTargetCatId == '' or not expectedCount or expectedCount < 0 or not count or count < 0 then
  return redis.error_reply('QUEUE_TARGET_EXPANSION_INVALID')
end
local anchorRaw = redis.call('HGET', rowsKey, anchorId)
if not anchorRaw then return {-2, ''} end
local anchor = cjson.decode(anchorRaw)
if anchor.status ~= 'queued' then return {0, ''} end
if type(anchor.targets) ~= 'table' then return {-1, ''} end

for i = 1, expectedCount do
  local expectedId = ARGV[4 + i]
  if expectedId ~= anchorId then return {0, ''} end
end

local seenTargets = {}
for i = 1, #anchor.targets do
  local targetId = anchor.targets[i]
  if type(targetId) ~= 'string' or targetId == '' or seenTargets[targetId] then return {-1, ''} end
  seenTargets[targetId] = true
end
local changed = false
if not seenTargets[bindTargetCatId] then
  anchor.targets[#anchor.targets + 1] = bindTargetCatId
  seenTargets[bindTargetCatId] = true
  changed = true
end

for i = 1, count do
  local raw = ARGV[4 + expectedCount + i]
  local row = cjson.decode(raw)
  if row.id ~= anchorId or row.threadId ~= anchor.threadId or row.status ~= 'queued' or row.payload.sourceRecordId ~= anchor.payload.sourceRecordId or type(row.targets) ~= 'table' then
    return redis.error_reply('QUEUE_TARGET_EXPANSION_INVALID_ROW')
  end
  for j = 1, #row.targets do
    local targetId = row.targets[j]
    if type(targetId) ~= 'string' or targetId == '' then return redis.error_reply('QUEUE_TARGET_EXPANSION_INVALID_ROW') end
    if not seenTargets[targetId] then
      anchor.targets[#anchor.targets + 1] = targetId
      seenTargets[targetId] = true
      changed = true
    end
  end
  if row.delivery and row.delivery.authorIntentByTarget then
    anchor.delivery = anchor.delivery or {}
    anchor.delivery.authorIntentByTarget = anchor.delivery.authorIntentByTarget or {}
    for targetId, intent in pairs(row.delivery.authorIntentByTarget) do
      anchor.delivery.authorIntentByTarget[targetId] = intent
    end
  end
end
if not changed then return {2, cjson.encode({anchorRaw})} end
anchorRaw = cjson.encode(anchor)
redis.call('HSET', rowsKey, anchorId, anchorRaw)
return {1, cjson.encode({anchorRaw})}
`;

export const RECONCILE_QUEUE_TARGETS_LUA = `
local function encodeRow(value)
  local encoded = cjson.encode(value)
  encoded = string.gsub(encoded, '"targets":{}', '"targets":[]')
  return encoded
end
local id = ARGV[1]
local addTargets = cjson.decode(ARGV[2])
local removeTargets = cjson.decode(ARGV[3])
local intentByTarget = cjson.decode(ARGV[4])
if type(addTargets) ~= 'table' or type(removeTargets) ~= 'table' or type(intentByTarget) ~= 'table' then
  return redis.error_reply('QUEUE_TARGET_RECONCILE_INVALID')
end
local raw = redis.call('HGET', KEYS[1], id)
if not raw then return {-1, ''} end
local row = cjson.decode(raw)
if row.status ~= 'queued' then return {0, raw} end
if type(row.targets) ~= 'table' then return redis.error_reply('QUEUE_TARGET_RECONCILE_INVALID_ROW') end

local removeSet = {}
for i = 1, #removeTargets do
  local targetId = removeTargets[i]
  if type(targetId) ~= 'string' or targetId == '' or removeSet[targetId] then
    return redis.error_reply('QUEUE_TARGET_RECONCILE_INVALID')
  end
  removeSet[targetId] = true
end
local addSet = {}
for i = 1, #addTargets do
  local targetId = addTargets[i]
  if type(targetId) ~= 'string' or targetId == '' or addSet[targetId] or removeSet[targetId] then
    return redis.error_reply('QUEUE_TARGET_RECONCILE_INVALID')
  end
  addSet[targetId] = true
end

local nextTargets = {}
local present = {}
for i = 1, #row.targets do
  local targetId = row.targets[i]
  if type(targetId) ~= 'string' or targetId == '' or present[targetId] then
    return redis.error_reply('QUEUE_TARGET_RECONCILE_INVALID_ROW')
  end
  if not removeSet[targetId] then
    nextTargets[#nextTargets + 1] = targetId
    present[targetId] = true
  end
end
for i = 1, #addTargets do
  local targetId = addTargets[i]
  if not present[targetId] then
    nextTargets[#nextTargets + 1] = targetId
    present[targetId] = true
  end
end

row.delivery = row.delivery or {}
local existingIntent = row.delivery.authorIntentByTarget or {}
local nextIntent = {}
for i = 1, #nextTargets do
  local targetId = nextTargets[i]
  if intentByTarget[targetId] then nextIntent[targetId] = intentByTarget[targetId]
  elseif existingIntent[targetId] then nextIntent[targetId] = existingIntent[targetId] end
end
row.targets = nextTargets
row.delivery.authorIntentByTarget = nextIntent
local next = encodeRow(row)
if next == raw then return {2, raw} end
if #nextTargets == 0 then
  redis.call('HDEL', KEYS[1], id)
  redis.call('LREM', KEYS[2], 1, id)
  local messageId = row.payload and row.payload.messageId
  if messageId and messageId ~= '' then redis.call('HDEL', KEYS[3], messageId) end
  return {1, ''}
end
redis.call('HSET', KEYS[1], id, next)
return {1, next}
`;

export {
  CLAIM_QUEUE_PREFIX_LUA,
  CLAIM_QUEUE_ROW_LUA,
  COMMIT_QUEUE_ROW_LUA,
  RESTORE_QUEUE_ROW_LUA,
} from './queue-ledger-redis-transition-scripts.js';
