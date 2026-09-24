/**
 * ADR-043 queue mutations. Every script performs all validation before its
 * first write because Redis does not roll back writes made before a Lua error.
 */
export const LIST_QUEUE_ROWS_LUA = `
local ids = redis.call('LRANGE', KEYS[2], 0, -1)
if #ids == 0 then return '[]' end
local rows = {}
for i = 1, #ids do
  local raw = redis.call('HGET', KEYS[1], ids[i])
  if not raw then return redis.error_reply('QUEUE_ORDER_ROW_MISSING:' .. ids[i]) end
  rows[#rows + 1] = raw
end
return cjson.encode(rows)
`;

export const GET_QUEUE_ROWS_BY_MESSAGE_IDS_LUA = `
local grouped = {}
for i = 1, #ARGV do
  local messageId = ARGV[i]
  local indexRaw = redis.call('HGET', KEYS[2], messageId)
  if indexRaw then
    local decodedOk, entryIds = pcall(cjson.decode, indexRaw)
    if not decodedOk or type(entryIds) ~= 'table' or #entryIds == 0 then
      return redis.error_reply('QUEUE_MESSAGE_INDEX_INVALID:' .. messageId)
    end
    local rows = {}
    for j = 1, #entryIds do
      local entryId = entryIds[j]
      if type(entryId) ~= 'string' or entryId == '' then
        return redis.error_reply('QUEUE_MESSAGE_INDEX_INVALID:' .. messageId)
      end
      local raw = redis.call('HGET', KEYS[1], entryId)
      if not raw then return redis.error_reply('QUEUE_MESSAGE_INDEX_ROW_MISSING:' .. entryId) end
      rows[#rows + 1] = raw
    end
    grouped[messageId] = rows
  end
end
return cjson.encode(grouped)
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

export { ENQUEUE_QUEUE_ROWS_LUA, MIGRATE_QUEUE_LEDGER_V2_LUA } from './queue-ledger-redis-admission-scripts.js';
export {
  CLAIM_QUEUE_PREFIX_LUA,
  CLAIM_QUEUE_ROW_LUA,
  COMMIT_QUEUE_ROW_LUA,
  RESTORE_QUEUE_ROW_LUA,
} from './queue-ledger-redis-transition-scripts.js';
