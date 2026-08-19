/** F276 Redis state transitions. Every script is atomic within one Redis instance. */

export { BEGIN_HARD_FORGET_LUA, FINISH_HARD_FORGET_LUA } from './person-memory-forget-lua.js';

export const STAGE_CANDIDATE_LUA = `
local locatedOwner = redis.call('GET', KEYS[2])
if locatedOwner and locatedOwner ~= ARGV[3] then return 'EXISTS' end
if redis.call('EXISTS', KEYS[1]) == 1 then return 'EXISTS' end
if ARGV[5] == '1' then
  local actualType = redis.call('TYPE', KEYS[3])['ok']
  if actualType ~= 'none' and actualType ~= 'string' then return 'DELTA_CONFLICT' end
  local lineage = redis.call('GET', KEYS[3])
  if lineage and lineage ~= ARGV[4] then return 'DELTA_CONFLICT' end
end
if ARGV[6] == '1' and redis.call('EXISTS', KEYS[4]) == 1 then
  return 'NOT_AVAILABLE'
end
if ARGV[5] == '1' then redis.call('SET', KEYS[3], ARGV[4]) end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[3])
if ARGV[6] == '1' then
  redis.call('SADD', KEYS[5], ARGV[2])
end
if ARGV[6] == '1' then
  redis.call('SADD', KEYS[6], KEYS[1])
  redis.call('SADD', KEYS[6], KEYS[2])
  if ARGV[5] == '1' then redis.call('SADD', KEYS[6], KEYS[3]) end
  redis.call('SADD', KEYS[6], KEYS[5])
end
return 'STAGED'
`;

/** Atomically moves one still-staged candidate onto the receipt's current live claim. */
export const RENEW_DEFERRED_CANDIDATE_CLAIM_LUA = `
if ARGV[10] == '1' and redis.call('EXISTS', KEYS[3]) == 1 then return 'NOT_AVAILABLE' end
local candidateRaw = redis.call('GET', KEYS[1])
local receiptRaw = redis.call('GET', KEYS[2])
if not candidateRaw or not receiptRaw then return 'NOT_AVAILABLE' end
local candidate = cjson.decode(candidateRaw)
local receipt = cjson.decode(receiptRaw)
if candidate.ownerUserId ~= ARGV[1] or candidate.candidateId ~= ARGV[2] then return 'CONFLICT' end
if candidate.state ~= 'staged' or not candidate.publication or candidate.publication.state ~= 'staged' then
  return 'CONFLICT'
end
if candidate.deferredReceiptId ~= ARGV[3] or candidate.deltaFingerprint ~= ARGV[6] then return 'CONFLICT' end
if receipt.ownerUserId ~= ARGV[1] or receipt.receiptId ~= ARGV[3] then return 'CONFLICT' end
if receipt.state ~= 'claimed' or receipt.claimId ~= ARGV[5] then return 'CONFLICT' end
if tonumber(receipt.claimUntil or 0) <= tonumber(ARGV[7]) then return 'CONFLICT' end
if receipt.dedupeHash ~= ARGV[6] then return 'CONFLICT' end
if candidate.deferredReceiptClaimId == ARGV[5] then return 'REPLAYED' end
if candidate.deferredReceiptClaimId ~= ARGV[4] then return 'CONFLICT' end
if candidateRaw ~= ARGV[8] then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[9])
return 'RENEWED'
`;

export const COMMIT_CANDIDATE_ENVELOPE_LUA = `
if #KEYS >= 3 and KEYS[3] ~= '' and redis.call('EXISTS', KEYS[3]) == 1 then
  return 'NOT_AVAILABLE'
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_AVAILABLE' end
local current = cjson.decode(raw)
if current.state ~= 'staged' then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], tonumber(ARGV[2]), ARGV[3])
return 'ANCHORED'
`;

/** Atomically consumes one exact deferred claim while anchoring its F276 card. */
export const COMMIT_DEFERRED_CANDIDATE_ENVELOPE_LUA = `
local function allowed_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  return actual == 'none' or actual == expected
end
if ARGV[10] == '1' and redis.call('EXISTS', KEYS[3]) == 1 then return 'NOT_AVAILABLE' end
if not allowed_type(KEYS[1], 'string') or not allowed_type(KEYS[2], 'zset')
  or not allowed_type(KEYS[4], 'string') or not allowed_type(KEYS[5], 'zset')
  or not allowed_type(KEYS[6], 'string') or not allowed_type(KEYS[7], 'set')
  or not allowed_type(KEYS[8], 'string') then return 'TYPE_CONFLICT' end
local candidateRaw = redis.call('GET', KEYS[1])
local receiptRaw = redis.call('GET', KEYS[4])
if not candidateRaw or not receiptRaw then return 'NOT_AVAILABLE' end
local candidate = cjson.decode(candidateRaw)
local receipt = cjson.decode(receiptRaw)
if candidate.state ~= 'staged' then return 'CONFLICT' end
if receipt.state ~= 'claimed' or receipt.claimId ~= ARGV[6] then return 'CONFLICT' end
if tonumber(receipt.claimUntil or 0) <= tonumber(ARGV[2]) then return 'CONFLICT' end
if receipt.receiptId ~= ARGV[5] or receipt.dedupeHash ~= ARGV[7] then return 'CONFLICT' end
if redis.call('GET', KEYS[8]) ~= ARGV[8] then return 'CONFLICT' end
if redis.call('SISMEMBER', KEYS[7], ARGV[5]) ~= 1 then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[2], tonumber(ARGV[2]), ARGV[3])
redis.call('SET', KEYS[4], ARGV[4])
redis.call('ZREM', KEYS[5], ARGV[5])
redis.call('SET', KEYS[6], ARGV[5])
redis.call('SREM', KEYS[7], ARGV[5])
redis.call('SET', KEYS[8], ARGV[9])
return 'ANCHORED'
`;

/**
 * Atomically anchors the corrected proposal and withdraws the superseded
 * owner-private proposal. KEYS[4..5] are optional hard-forget fences for the
 * replacement and original candidate respectively.
 */
export const COMMIT_REPLACEMENT_ENVELOPE_LUA = `
if KEYS[4] ~= '' and redis.call('EXISTS', KEYS[4]) == 1 then return 'NOT_AVAILABLE' end
if KEYS[5] ~= '' and redis.call('EXISTS', KEYS[5]) == 1 then return 'NOT_AVAILABLE' end
local newRaw = redis.call('GET', KEYS[1])
local oldRaw = redis.call('GET', KEYS[3])
if not newRaw or not oldRaw then return 'NOT_AVAILABLE' end
local newCandidate = cjson.decode(newRaw)
local oldCandidate = cjson.decode(oldRaw)
if newCandidate.state ~= 'staged' then return 'CONFLICT' end
if oldCandidate.state ~= 'pending_approval' and oldCandidate.state ~= 'not_now' then
  return 'CONFLICT'
end
if not oldCandidate.publication or oldCandidate.publication.state ~= 'anchored' then
  return 'CONFLICT'
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('ZREM', KEYS[2], ARGV[5])
redis.call('ZADD', KEYS[2], tonumber(ARGV[2]), ARGV[3])
return 'ANCHORED'
`;

/** Withdraw one unmaterialized owner proposal without creating suppression. */
export const WITHDRAW_CANDIDATE_LUA = `
if ARGV[5] == '1' and redis.call('EXISTS', KEYS[3]) == 1 then return 'NOT_AVAILABLE' end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_AVAILABLE' end
local current = cjson.decode(raw)
if current.state ~= 'pending_approval' and current.state ~= 'not_now' then
  return 'CONFLICT'
end
if not current.publication or current.publication.state ~= 'anchored' then
  return 'CONFLICT'
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[2])
if ARGV[4] == '1' and redis.call('GET', KEYS[4]) == ARGV[3] then redis.call('DEL', KEYS[4]) end
return 'UPDATED'
`;

export const ABORT_STAGED_CANDIDATE_LUA = `
if ARGV[4] == '1' and redis.call('EXISTS', KEYS[4]) == 1 then
  return 'NOT_AVAILABLE'
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.state ~= 'staged' then return 0 end
if ARGV[3] == '1' and redis.call('GET', KEYS[3]) == ARGV[2] then redis.call('DEL', KEYS[3]) end
redis.call('DEL', KEYS[1], KEYS[2])
if ARGV[4] == '1' then
  redis.call('SREM', KEYS[5], ARGV[1])
end
if ARGV[4] == '1' then
  redis.call('SREM', KEYS[6], KEYS[1])
  redis.call('SREM', KEYS[6], KEYS[2])
  if ARGV[3] == '1' then redis.call('SREM', KEYS[6], KEYS[3]) end
  redis.call('SREM', KEYS[6], KEYS[5])
end
return 1
`;

/**
 * KEYS[1..3] = candidate, pending index, optional suppression token.
 * ARGV[6..9] = fence key index, artifact-set key index, subject-key start, subject-key count.
 */
export const UPDATE_CANDIDATE_STATE_LUA = `
local fenceKeyIndex = tonumber(ARGV[6]) or 0
if fenceKeyIndex > 0 and redis.call('EXISTS', KEYS[fenceKeyIndex]) == 1 then
  return 'NOT_AVAILABLE'
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_AVAILABLE' end
local current = cjson.decode(raw)
if current.state ~= 'pending_approval' and current.state ~= 'not_now' and current.state ~= 'partially_materialized' then
  return 'CONFLICT'
end
redis.call('SET', KEYS[1], ARGV[1])
if ARGV[2] == 'keep_pending' then
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[4])
else
  redis.call('ZREM', KEYS[2], ARGV[4])
end
if ARGV[2] == 'remove_pending' and #KEYS >= 3 and ARGV[5] ~= '' then
  redis.call('SET', KEYS[3], ARGV[5])
end
local artifactKeyIndex = tonumber(ARGV[7]) or 0
if ARGV[2] == 'remove_pending' and artifactKeyIndex > 0 then
  redis.call('SADD', KEYS[artifactKeyIndex], KEYS[3])
end
local subjectKeyStart = tonumber(ARGV[8]) or 0
local subjectKeyCount = tonumber(ARGV[9]) or 0
if ARGV[2] == 'remove_pending' and subjectKeyStart > 0 then
  for offset = 0, subjectKeyCount - 1 do
    redis.call('SADD', KEYS[subjectKeyStart + offset], ARGV[4])
  end
end
return 'UPDATED'
`;

/**
 * F281 feedback-bearing rejection. The expected raw snapshot prevents a stale
 * subject key plan from mutating F282 registries after candidate drift.
 *
 * KEYS[1..3] = candidate, pending index, per-candidate suppression.
 * Remaining keys are subject memberships, optional personArtifacts, and
 * optional hard-forget fence. ARGV[7..10] carry their 1-based indexes.
 */
export const REJECT_CANDIDATE_LUA = `
local fenceKeyIndex = tonumber(ARGV[7]) or 0
if fenceKeyIndex > 0 and redis.call('EXISTS', KEYS[fenceKeyIndex]) == 1 then
  return 'NOT_AVAILABLE'
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_AVAILABLE' end
if raw ~= ARGV[1] then return 'SNAPSHOT_CONFLICT' end
local current = cjson.decode(raw)

local function feedbackMatches(existing, incomingRaw)
  if incomingRaw == '' then return existing == nil end
  if existing == nil then return false end
  local incoming = cjson.decode(incomingRaw)
  if existing.reasonCode ~= incoming.reasonCode then return false end
  return existing.detail == incoming.detail
end

if current.state == 'rejected' then
  if current.latestDecisionId == nil and current.latestHumanDisposition == nil and ARGV[6] == '' then
    return 'REPLAYED'
  end
  if current.latestDecisionId == ARGV[5] and feedbackMatches(current.latestHumanDisposition, ARGV[6]) then
    return 'REPLAYED'
  end
  return 'CONFLICT'
end
if current.state ~= 'pending_approval' and current.state ~= 'not_now' and current.state ~= 'partially_materialized' then
  return 'CONFLICT'
end
if not current.publication or current.publication.state ~= 'anchored' then
  return 'CONFLICT'
end

redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])

local artifactKeyIndex = tonumber(ARGV[8]) or 0
if artifactKeyIndex > 0 then
  redis.call('SADD', KEYS[artifactKeyIndex], KEYS[3])
end
local subjectKeyStart = tonumber(ARGV[9]) or 0
local subjectKeyCount = tonumber(ARGV[10]) or 0
if subjectKeyStart > 0 then
  for offset = 0, subjectKeyCount - 1 do
    redis.call('SADD', KEYS[subjectKeyStart + offset], ARGV[3])
  end
end
return 'UPDATED'
`;

/**
 * KEYS[1..3] = candidate, pending index, decision receipt.
 * Remaining KEYS are referenced by 1-based keyIndex values in ARGV[6].
 */
export const APPROVE_DRAFTS_LUA = `
local prior = redis.call('GET', KEYS[3])
if prior then return 'REPLAYED:' .. prior end

local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_AVAILABLE' end
local candidate = cjson.decode(raw)
if candidate.state ~= 'pending_approval' and candidate.state ~= 'not_now' and candidate.state ~= 'partially_materialized' then
  return 'CONFLICT'
end
if not candidate.publication or candidate.publication.state ~= 'anchored' then
  return 'CONFLICT'
end

local selected = cjson.decode(ARGV[1])
if #selected == 0 then return 'CONFLICT' end
local remaining = {}
for _, draftId in ipairs(candidate.remainingDraftIds or {}) do
  remaining[draftId] = true
end
for _, draftId in ipairs(selected) do
  if not remaining[draftId] then return 'CONFLICT' end
end

local plan = cjson.decode(ARGV[6])
for _, keyIndex in ipairs(plan.fenceKeyIndexes or {}) do
  if redis.call('EXISTS', KEYS[keyIndex]) == 1 then return 'NOT_AVAILABLE' end
end
for _, precondition in ipairs(plan.preconditions or {}) do
  if precondition.kind == 'zrange' then
    local actual = redis.call('ZRANGE', KEYS[precondition.keyIndex], 0, -1)
    if cjson.encode(actual) ~= cjson.encode(precondition.expected) then return 'CONFLICT' end
  else
    local actual = redis.call('GET', KEYS[precondition.keyIndex])
    if not actual then actual = '' end
    if actual ~= precondition.expected then return 'CONFLICT' end
  end
end

for _, mutation in ipairs(plan.mutations or {}) do
  local key = KEYS[mutation.keyIndex]
  if mutation.op == 'set' then
    redis.call('SET', key, mutation.value)
  elseif mutation.op == 'sadd' then
    redis.call('SADD', key, mutation.member)
  elseif mutation.op == 'srem' then
    redis.call('SREM', key, mutation.member)
  elseif mutation.op == 'zadd' then
    redis.call('ZADD', key, tonumber(mutation.score), mutation.member)
  elseif mutation.op == 'zrem' then
    redis.call('ZREM', key, mutation.member)
  elseif mutation.op == 'del' then
    redis.call('DEL', key)
  else
    return redis.error_reply('unsupported F276 mutation op')
  end
end

redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3])
if ARGV[4] == 'materialized' then
  redis.call('ZREM', KEYS[2], ARGV[5])
else
  redis.call('ZADD', KEYS[2], tonumber(ARGV[7]), ARGV[5])
end
return 'APPLIED:' .. ARGV[3]
`;

/** Exact-decision rollback with candidate/object CAS and idempotent content-free receipt. */
export const UNDO_DECISION_LUA = `
local prior = redis.call('GET', KEYS[3])
if prior then return 'REPLAYED:' .. prior end
if redis.call('EXISTS', KEYS[5]) == 1 then return 'NOT_AVAILABLE' end
local candidate = redis.call('GET', KEYS[1])
local decision = redis.call('GET', KEYS[2])
if not candidate or not decision then return 'NOT_AVAILABLE' end

local plan = cjson.decode(ARGV[3])
for _, keyIndex in ipairs(plan.fenceKeyIndexes or {}) do
  if redis.call('EXISTS', KEYS[keyIndex]) == 1 then return 'NOT_AVAILABLE' end
end
for _, precondition in ipairs(plan.preconditions or {}) do
  if precondition.kind == 'zrange' then
    local actual = redis.call('ZRANGE', KEYS[precondition.keyIndex], 0, -1)
    if cjson.encode(actual) ~= cjson.encode(precondition.expected) then return 'CONFLICT' end
  else
    local actual = redis.call('GET', KEYS[precondition.keyIndex])
    if not actual then actual = '' end
    if actual ~= precondition.expected then return 'CONFLICT' end
  end
end
for _, mutation in ipairs(plan.mutations or {}) do
  local key = KEYS[mutation.keyIndex]
  if mutation.op == 'set' then
    redis.call('SET', key, mutation.value)
  elseif mutation.op == 'sadd' then
    redis.call('SADD', key, mutation.member)
  elseif mutation.op == 'srem' then
    redis.call('SREM', key, mutation.member)
  elseif mutation.op == 'zadd' then
    redis.call('ZADD', key, tonumber(mutation.score), mutation.member)
  elseif mutation.op == 'zrem' then
    redis.call('ZREM', key, mutation.member)
  elseif mutation.op == 'del' then
    redis.call('DEL', key)
  else
    return redis.error_reply('unsupported F276 undo mutation op')
  end
end
redis.call('SET', KEYS[3], ARGV[2])
if ARGV[4] == 'keep_pending' then
  redis.call('ZADD', KEYS[4], tonumber(ARGV[5]), ARGV[1])
else
  redis.call('ZREM', KEYS[4], ARGV[1])
end
return 'APPLIED:' .. ARGV[2]
`;
