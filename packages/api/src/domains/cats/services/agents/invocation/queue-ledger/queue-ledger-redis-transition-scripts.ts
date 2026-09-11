export const CLAIM_QUEUE_ROW_LUA = `
local function encodeRow(value)
  local encoded = cjson.encode(value)
  encoded = string.gsub(encoded, '"targets":{}', '"targets":[]')
  encoded = string.gsub(encoded, '"claimedTargetIds":{}', '"claimedTargetIds":[]')
  return encoded
end
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return {-1, ''} end
local row = cjson.decode(raw)
if row.status ~= 'queued' then return {0, raw} end
row.status = 'claimed'
row.claimId = ARGV[2]
row.claimedAt = tonumber(ARGV[3])
local bindTargetCatId = ARGV[4]
if bindTargetCatId and bindTargetCatId ~= '' then
  if type(row.targets) ~= 'table' then return {0, raw} end
  local found = false
  for i = 1, #row.targets do if row.targets[i] == bindTargetCatId then found = true end end
  if #row.targets > 0 and not found then return {0, raw} end
  if #row.targets == 0 then
    row.targets = { bindTargetCatId }
    row.claimedFromTargetless = true
  end
  row.claimedTargetIds = { bindTargetCatId }
else
  row.claimedTargetIds = row.targets
end
local steerRequestedAt = tonumber(ARGV[5])
if steerRequestedAt then row.delivery.steerRequestedAt = steerRequestedAt end
local next = encodeRow(row)
redis.call('HSET', KEYS[1], ARGV[1], next)
return {1, next}
`;

export const CLAIM_QUEUE_PREFIX_LUA = `
local function encodeRow(value)
  local encoded = cjson.encode(value)
  encoded = string.gsub(encoded, '"targets":{}', '"targets":[]')
  encoded = string.gsub(encoded, '"claimedTargetIds":{}', '"claimedTargetIds":[]')
  return encoded
end
local count = tonumber(ARGV[1])
if not count or count < 1 then return redis.error_reply('QUEUE_CLAIM_PREFIX_EMPTY') end
local claimId = ARGV[2]
local claimedAt = tonumber(ARGV[3])
local bindTargetCatId = ARGV[4]
local steerRequestedAt = tonumber(ARGV[5])
local rows = {}
for i = 1, count do
  local id = ARGV[5 + i]
  local raw = redis.call('HGET', KEYS[1], id)
  if not raw then return {-1, ''} end
  local row = cjson.decode(raw)
  if row.status ~= 'queued' then return {0, raw} end
  if bindTargetCatId and bindTargetCatId ~= '' then
    if type(row.targets) ~= 'table' then return {0, raw} end
    local found = false
    for j = 1, #row.targets do if row.targets[j] == bindTargetCatId then found = true end end
    if #row.targets > 0 and not found then return {0, raw} end
  end
  rows[i] = { id = id, row = row }
end
local encoded = {}
for i = 1, count do
  rows[i].row.status = 'claimed'
  rows[i].row.claimId = claimId
  rows[i].row.claimedAt = claimedAt
  if bindTargetCatId and bindTargetCatId ~= '' then
    if #rows[i].row.targets == 0 then
      rows[i].row.targets = { bindTargetCatId }
      rows[i].row.claimedFromTargetless = true
    end
    rows[i].row.claimedTargetIds = { bindTargetCatId }
  else
    rows[i].row.claimedTargetIds = rows[i].row.targets
  end
  if steerRequestedAt then rows[i].row.delivery.steerRequestedAt = steerRequestedAt end
  local next = encodeRow(rows[i].row)
  redis.call('HSET', KEYS[1], rows[i].id, next)
  encoded[i] = next
end
return {1, cjson.encode(encoded)}
`;

export const COMMIT_QUEUE_ROW_LUA = `
local function encodeRow(value)
  local encoded = cjson.encode(value)
  encoded = string.gsub(encoded, '"targets":{}', '"targets":[]')
  encoded = string.gsub(encoded, '"claimedTargetIds":{}', '"claimedTargetIds":[]')
  return encoded
end
local id = ARGV[1]
local claimId = ARGV[2]
local mode = ARGV[3]
local at = tonumber(ARGV[4])
local replacementRaw = ARGV[5]
local raw = redis.call('HGET', KEYS[1], id)
if not raw then return {-1, ''} end
local row = cjson.decode(raw)

if mode == 'processing_evidence' or mode == 'terminal' then return {0, raw} end

if mode == 'queued' then
  if row.status ~= 'claimed' or row.claimId ~= claimId then return {0, raw} end
  local nextRow = row
  if replacementRaw and replacementRaw ~= '' then
    nextRow = cjson.decode(replacementRaw)
    if nextRow.id ~= id or nextRow.threadId ~= row.threadId then
      return redis.error_reply('QUEUE_COMMIT_IDENTITY_MISMATCH')
    end
  end
  nextRow.status = 'queued'
  nextRow.processingStartedAt = nil
  nextRow.claimId = nil
  nextRow.claimedAt = nil
  nextRow.claimedTargetIds = nil
  nextRow.claimedFromTargetless = nil
  local next = encodeRow(nextRow)
  redis.call('HSET', KEYS[1], id, next)
  return {1, next}
end

local function removeMessageIndex(rowToRemove)
  local messageId = rowToRemove.payload and rowToRemove.payload.messageId
  if not messageId or messageId == '' then return end
  redis.call('HDEL', KEYS[3], messageId)
end

if mode == 'processing' then
  if row.status ~= 'claimed' or row.claimId ~= claimId or type(row.claimedTargetIds) ~= 'table' or #row.claimedTargetIds == 0 then
    return {0, raw}
  end
  local attempted = cjson.decode(raw)
  if replacementRaw and replacementRaw ~= '' then
    attempted = cjson.decode(replacementRaw)
    if attempted.id ~= id or attempted.threadId ~= row.threadId then
      return redis.error_reply('QUEUE_COMMIT_IDENTITY_MISMATCH')
    end
  end
  attempted.targets = row.claimedTargetIds
  attempted.status = 'processing'
  attempted.processingStartedAt = at
  attempted.claimId = nil
  attempted.claimedAt = nil
  attempted.claimedTargetIds = nil
  attempted.claimedFromTargetless = nil
  attempted.terminalAt = nil

  local claimed = {}
  for i = 1, #row.claimedTargetIds do claimed[row.claimedTargetIds[i]] = true end
  local remainingTargets = {}
  for i = 1, #row.targets do
    if not claimed[row.targets[i]] then remainingTargets[#remainingTargets + 1] = row.targets[i] end
  end
  if #remainingTargets == 0 then
    redis.call('HDEL', KEYS[1], id)
    redis.call('LREM', KEYS[2], 1, id)
    removeMessageIndex(row)
  else
    row.targets = remainingTargets
    row.status = 'queued'
    row.processingStartedAt = nil
    row.claimId = nil
    row.claimedAt = nil
    row.claimedTargetIds = nil
    row.claimedFromTargetless = nil
    row.terminalAt = nil
    if row.delivery then
      row.delivery.steerRequestedAt = nil
      if row.delivery.authorIntentByTarget then
        local remainingIntent = {}
        for i = 1, #remainingTargets do
          local targetId = remainingTargets[i]
          if row.delivery.authorIntentByTarget[targetId] then
            remainingIntent[targetId] = row.delivery.authorIntentByTarget[targetId]
          end
        end
        row.delivery.authorIntentByTarget = remainingIntent
      end
    end
    redis.call('HSET', KEYS[1], id, encodeRow(row))
  end
  return {1, encodeRow(attempted)}
end

if mode ~= 'withdrawn' then
  return redis.error_reply('QUEUE_COMMIT_INVALID_MODE')
end
if row.status ~= 'claimed' or row.claimId ~= claimId then return {0, raw} end
if replacementRaw and replacementRaw ~= '' then
  local replacement = cjson.decode(replacementRaw)
  if replacement.id ~= id or replacement.threadId ~= row.threadId then
    return redis.error_reply('QUEUE_COMMIT_IDENTITY_MISMATCH')
  end
  row = replacement
end
row.status = 'terminal'
row.terminalAt = at
row.claimId = nil
row.claimedAt = nil
row.claimedTargetIds = nil
row.claimedFromTargetless = nil
local terminal = encodeRow(row)
redis.call('HDEL', KEYS[1], id)
redis.call('LREM', KEYS[2], 1, id)
removeMessageIndex(row)
return {1, terminal}
`;

export const RESTORE_QUEUE_ROW_LUA = `
local function encodeRow(value)
  local encoded = cjson.encode(value)
  encoded = string.gsub(encoded, '"targets":{}', '"targets":[]')
  encoded = string.gsub(encoded, '"claimedTargetIds":{}', '"claimedTargetIds":[]')
  return encoded
end
local raw = redis.call('HGET', KEYS[1], ARGV[1])
if not raw then return {-1, ''} end
local row = cjson.decode(raw)
if row.status ~= 'claimed' or row.claimId ~= ARGV[2] then return {0, raw} end
row.status = 'queued'
row.claimId = nil
row.claimedAt = nil
row.delivery.steerRequestedAt = nil
if ARGV[3] == '1' or row.claimedFromTargetless then
  row.targets = cjson.decode('[]')
end
row.claimedTargetIds = nil
row.claimedFromTargetless = nil
local next = encodeRow(row)
redis.call('HSET', KEYS[1], ARGV[1], next)
return {1, next}
`;
