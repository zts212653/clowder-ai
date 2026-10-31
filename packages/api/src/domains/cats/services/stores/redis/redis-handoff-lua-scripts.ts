/**
 * Lua scripts for RedisSessionHandoffProposalStore.
 *
 * Extracted from the main store file to keep it within the 350-line SOP limit.
 * All scripts are atomic Redis operations (Lua is single-threaded in Redis).
 */
import { HUMAN_DISPOSITION_RECEIPT_FUNCTIONS_LUA } from '../../../../human-disposition/human-disposition-lua.js';

/**
 * Compare-and-delete: DEL the dedup key only if it still points at the expected proposalId, so a
 * release never wipes a sibling's reservation that already replaced the key.
 * KEYS[1] = dedup key; ARGV[1] = expectedProposalId.
 */
export const RELEASE_DEDUP_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * CAS Lua: atomically check current status ∈ expected (comma-separated) → HSET field/value pairs.
 * KEYS[1] = detail hash; ARGV[1] = expected statuses ("pending" | "pending,approving");
 * ARGV[2..] = HSET pairs (caller includes new status + updatedAt).
 * Returns 1 on match, 0 otherwise (incl. missing key — HGET returns false).
 */
export const CAS_STATUS_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return 0 end
local matched = false
for st in string.gmatch(ARGV[1], '[^,]+') do
  if st == current then matched = true end
end
if not matched then return 0 end
local fields = {}
for i = 2, #ARGV do fields[#fields + 1] = ARGV[i] end
if #fields > 0 then redis.call('HSET', KEYS[1], unpack(fields)) end
return 1
`;

/**
 * CAS + settle index update — atomic in a single Lua script (F246 Phase G P1 fix).
 *
 * Why: A two-step approach (cas() → pipeline ZADD) leaves a crash window where the hash
 * reaches terminal status (approved/rejected) but the settled sorted set is never updated.
 * The proposal becomes invisible to listSettledByUser() with no way to recover without
 * a manual backfill. Running everything in one Lua script eliminates that window because
 * Redis guarantees Lua execution is atomic.
 *
 * Approval uses KEYS[1..3] and ARGV[1..5].
 * Rejection adds F281 receipt/index KEYS[4..6] and ARGV[6..9].
 * ARGV[1] = expected status (single value — "approving" or "pending")
 * ARGV[2] = new status ("approved" or "rejected")
 * ARGV[3] = updatedAt as string (used as ZADD score and HSET value)
 * ARGV[4] = proposalId (ZSet member for ZREM/ZADD)
 * ARGV[5] = normalized feedback JSON, or empty string when absent
 * ARGV[6] = producer-owned full ledger entry JSON (reject only)
 * ARGV[7] = content-free receipt JSON (reject only)
 * ARGV[8] = receipt sourceRef (reject only)
 * ARGV[9] = exact subjectRef (reject only)
 */
export const CAS_AND_SETTLE_LUA = `
${HUMAN_DISPOSITION_RECEIPT_FUNCTIONS_LUA}
local function finite_number(text)
  local value = tonumber(text)
  if value == nil or value ~= value or value == math.huge or value == -math.huge then
    return nil
  end
  return value
end

local function exact_fields(value, allowed, expected_count)
  if type(value) ~= 'table' then return false end
  local count = 0
  for key, _ in pairs(value) do
    if not allowed[key] then return false end
    count = count + 1
  end
  return count == expected_count
end

local function valid_feedback(feedback)
  if type(feedback) ~= 'table' or type(feedback.reasonCode) ~= 'string' then return false end
  local reason = feedback.reasonCode
  if reason == 'other' then
    return exact_fields(feedback, { reasonCode = true, detail = true }, 2)
      and type(feedback.detail) == 'string' and feedback.detail ~= ''
  end
  return exact_fields(feedback, { reasonCode = true }, 1)
    and (reason == 'not_important' or reason == 'wrong_lane' or reason == 'bad_evidence'
      or reason == 'not_now' or reason == 'wrong')
end

local function valid_f225_entry(entry, source_ref, subject_ref, proposal_id, score, feedback)
  local has_feedback = feedback ~= nil
  if not exact_fields(entry, { episode = true, envelope = true }, has_feedback and 2 or 1) then return false end
  local episode = entry.episode
  local episode_fields = {
    interactionKind = true, subjectRef = true, proposalId = true, decision = true,
    producerCatId = true, ownerUserId = true, decidedAt = true, sourceRef = true, feedback = true
  }
  if not exact_fields(episode, episode_fields, has_feedback and 9 or 8)
    or episode.interactionKind ~= 'session_handoff'
    or episode.subjectRef ~= subject_ref
    or episode.proposalId ~= proposal_id
    or episode.decision ~= 'rejected'
    or type(episode.producerCatId) ~= 'string' or episode.producerCatId == ''
    or type(episode.ownerUserId) ~= 'string' or episode.ownerUserId == ''
    or episode.decidedAt ~= score
    or episode.sourceRef ~= source_ref then
    return false
  end
  if not has_feedback then return episode.feedback == nil and entry.envelope == nil end
  if not valid_feedback(episode.feedback)
    or episode.feedback.reasonCode ~= feedback.reasonCode
    or episode.feedback.detail ~= feedback.detail then
    return false
  end

  local envelope = entry.envelope
  local envelope_fields = {
    interactionKind = true, subjectRef = true, proposalId = true, decision = true,
    producerCatId = true, ownerUserId = true, decidedAt = true, scope = true,
    expiry = true, invalidator = true, sourceRef = true, feedback = true
  }
  return exact_fields(envelope, envelope_fields, 12)
    and envelope.interactionKind == episode.interactionKind
    and envelope.subjectRef == episode.subjectRef
    and envelope.proposalId == episode.proposalId
    and envelope.decision == episode.decision
    and envelope.producerCatId == episode.producerCatId
    and envelope.ownerUserId == episode.ownerUserId
    and envelope.decidedAt == episode.decidedAt
    and envelope.sourceRef == episode.sourceRef
    and valid_feedback(envelope.feedback)
    and envelope.feedback.reasonCode == feedback.reasonCode
    and envelope.feedback.detail == feedback.detail
    and exact_fields(envelope.scope, { kind = true }, 1) and envelope.scope.kind == 'exact_subject'
    and exact_fields(envelope.expiry, { kind = true }, 1) and envelope.expiry.kind == 'none'
    and exact_fields(envelope.invalidator, { kind = true }, 1) and envelope.invalidator.kind == 'none'
end

local rejecting = ARGV[2] == 'rejected'
if (rejecting and (#KEYS ~= 6 or #ARGV ~= 9))
  or ((not rejecting) and (#KEYS ~= 3 or #ARGV ~= 5)) then
  return 'INVALID_ARGUMENTS'
end
if redis_type_name(KEYS[1]) ~= 'hash'
  or not allowed_type(KEYS[2], 'zset')
  or not allowed_type(KEYS[3], 'zset') then
  return 'TYPE_CONFLICT'
end
local score = finite_number(ARGV[3])
if score == nil or ARGV[4] == '' then
  return 'INVALID_ARGUMENTS'
end

local current = redis.call('HGET', KEYS[1], 'status')
if not current then return 'CAS_MISS' end

if rejecting then
  local ok_entry, entry = pcall(cjson.decode, ARGV[6])
  local feedback = nil
  if ARGV[5] ~= '' then
    local ok_feedback, decoded_feedback = pcall(cjson.decode, ARGV[5])
    if not ok_feedback or not valid_feedback(decoded_feedback) then return 'INVALID_FEEDBACK' end
    feedback = decoded_feedback
  end
  if not ok_entry or not valid_f225_entry(entry, ARGV[8], ARGV[9], ARGV[4], score, feedback) then
    return 'INVALID_ENTRY'
  end

  local receipt_status = preflight_human_disposition_receipt(
    KEYS[4],
    KEYS[5],
    KEYS[6],
    ARGV[7],
    ARGV[8],
    ARGV[9],
    ARGV[3]
  )
  if receipt_status ~= 'NEW' and receipt_status ~= 'REPLAY' and receipt_status ~= 'CONFLICT' then
    return receipt_status
  end
  local stored_entry = redis.call('HGET', KEYS[1], 'humanDispositionLedgerEntry')
  local stored_feedback = redis.call('HGET', KEYS[1], 'latestHumanDisposition')

  if current == 'rejected' then
    if not stored_entry then return 'LEGACY_UNMIGRATED' end
    local stored_ok, stored_decoded = pcall(cjson.decode, stored_entry)
    if not stored_ok or type(stored_decoded) ~= 'table' then return 'INVARIANT_FAILURE' end
    if stored_entry ~= ARGV[6] then return 'CONFLICT' end
    if (ARGV[5] == '' and stored_feedback) or (ARGV[5] ~= '' and stored_feedback ~= ARGV[5]) then
      return 'INVARIANT_FAILURE'
    end
    local settled_score = redis.call('ZSCORE', KEYS[3], ARGV[4])
    if receipt_status ~= 'REPLAY'
      or redis.call('ZSCORE', KEYS[2], ARGV[4])
      or not settled_score
      or tonumber(settled_score) ~= score then
      return 'INVARIANT_FAILURE'
    end
    return 'REPLAY'
  end

  if current ~= ARGV[1] then return 'CAS_MISS' end
  if receipt_status ~= 'NEW' or stored_entry or stored_feedback
    or not redis.call('ZSCORE', KEYS[2], ARGV[4])
    or redis.call('ZSCORE', KEYS[3], ARGV[4]) then
    return 'INVARIANT_FAILURE'
  end
else
  if current ~= ARGV[1] then return 'CAS_MISS' end
  if not redis.call('ZSCORE', KEYS[2], ARGV[4])
    or redis.call('ZSCORE', KEYS[3], ARGV[4]) then
    return 'INVARIANT_FAILURE'
  end
end

redis.call('HSET', KEYS[1], 'status', ARGV[2], 'updatedAt', ARGV[3])
if rejecting then
  redis.call('HSET', KEYS[1], 'humanDispositionLedgerEntry', ARGV[6])
  if ARGV[5] ~= '' then
    redis.call('HSET', KEYS[1], 'latestHumanDisposition', ARGV[5])
  else
    redis.call('HDEL', KEYS[1], 'latestHumanDisposition')
  end
end
redis.call('ZREM', KEYS[2], ARGV[4])
redis.call('ZADD', KEYS[3], score, ARGV[4])
if rejecting then
  write_human_disposition_receipt(KEYS[4], KEYS[5], KEYS[6], ARGV[7], ARGV[8], score)
end
return 'APPLIED'
`;
