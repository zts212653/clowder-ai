import { HUMAN_DISPOSITION_RECEIPT_FUNCTIONS_LUA } from '../../human-disposition/human-disposition-lua.js';
import { PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA } from './person-memory-disposition-lua-preflight.js';
import { F276_DISPOSITION_VALIDATION_LUA } from './person-memory-disposition-reject-lua.js';

/**
 * Pure-unbound terminal rejection. The exact proposal lineage owns the
 * disposition binding and deletion fence; no hidden person identity is minted.
 */
export const REJECT_PROPOSAL_DISPOSITION_CANDIDATE_LUA = `
${PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA}
${HUMAN_DISPOSITION_RECEIPT_FUNCTIONS_LUA}
${F276_DISPOSITION_VALIDATION_LUA}
if #KEYS < 10 or #ARGV ~= 18 then return 'INVALID_ARGUMENTS' end
if not allowed_type(KEYS[1], 'string')
  or not allowed_type(KEYS[2], 'zset')
  or not allowed_type(KEYS[3], 'string')
  or not allowed_type(KEYS[4], 'string')
  or not allowed_type(KEYS[5], 'string')
  or not allowed_type(KEYS[6], 'string')
  or not allowed_type(KEYS[7], 'string')
  or not allowed_type(KEYS[8], 'hash')
  or not allowed_type(KEYS[9], 'zset')
  or not allowed_type(KEYS[10], 'zset') then
  return 'TYPE_CONFLICT'
end
for index = 11, #KEYS do
  if not allowed_type(KEYS[index], 'set') then return 'TYPE_CONFLICT' end
end
if redis.call('EXISTS', KEYS[7]) == 1 then return 'NOT_AVAILABLE' end
local score = finite_number(ARGV[14])
if not score
  or not valid_json(ARGV[2])
  or not valid_json(ARGV[4])
  or not valid_json(ARGV[7])
  or not valid_json(ARGV[8])
  or not valid_json(ARGV[9])
  or not valid_json(ARGV[10])
  or not valid_json(ARGV[11]) then
  return 'INVALID_ARGUMENTS'
end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_AVAILABLE' end
if raw ~= ARGV[1] then return 'SNAPSHOT_CONFLICT' end
local current = cjson.decode(raw)
local incoming = cjson.decode(ARGV[2])
local binding = cjson.decode(ARGV[7])
local updatedBinding = cjson.decode(ARGV[8])
local lineageLocator = cjson.decode(ARGV[9])
local decisionLocator = cjson.decode(ARGV[10])
local receipt = cjson.decode(ARGV[11])
local feedback = nil
if ARGV[6] ~= '' then
  local feedbackOk, decodedFeedback = pcall(cjson.decode, ARGV[6])
  if not feedbackOk or not valid_feedback(decodedFeedback) then return 'INVALID_ARGUMENTS' end
  feedback = decodedFeedback
end
local entryFeedback = feedback
if current.state == 'rejected' then entryFeedback = current.latestHumanDisposition end
if not exact_fields(binding, {
    version = true, ownerUserId = true, purgeScope = true, rootCandidateId = true,
    currentCandidateId = true, opaqueLineageHandle = true, currentOpaqueProposalHandle = true,
    currentOpaqueSupersessionHandle = true, latestDecisionReceiptHandle = true
  }, binding.latestDecisionReceiptHandle and 9 or 8)
  or binding.purgeScope ~= 'exact_proposal'
  or not exact_fields(updatedBinding, {
    version = true, ownerUserId = true, purgeScope = true, rootCandidateId = true,
    currentCandidateId = true, opaqueLineageHandle = true, currentOpaqueProposalHandle = true,
    currentOpaqueSupersessionHandle = true, latestDecisionReceiptHandle = true
  }, 9)
  or updatedBinding.purgeScope ~= 'exact_proposal'
  or not exact_fields(lineageLocator, {
    bindingKey = true, purgeScope = true, rootCandidateId = true
  }, 3)
  or lineageLocator.purgeScope ~= 'exact_proposal'
  or not exact_fields(decisionLocator, {
    bindingKey = true, candidateKey = true, purgeScope = true, rootCandidateId = true
  }, 4)
  or decisionLocator.purgeScope ~= 'exact_proposal'
  or not valid_f276_entry(
    incoming.humanDispositionLedgerEntry, updatedBinding, ARGV[12], ARGV[13], score, entryFeedback
  )
  or (current.state ~= 'rejected' and (
    current.dispositionLineageBindingKey ~= nil
    or incoming.dispositionLineageBindingKey ~= ARGV[17]
    or incoming.latestDecisionId ~= ARGV[5]
    or (feedback == nil and incoming.latestHumanDisposition ~= nil)
    or (feedback ~= nil and (not valid_feedback(incoming.latestHumanDisposition)
      or incoming.latestHumanDisposition.reasonCode ~= feedback.reasonCode
      or incoming.latestHumanDisposition.detail ~= feedback.detail))
  )) then
  return 'INVALID_ARGUMENTS'
end
if binding.ownerUserId ~= incoming.ownerUserId
  or binding.rootCandidateId ~= lineageLocator.rootCandidateId
  or binding.rootCandidateId ~= decisionLocator.rootCandidateId
  or binding.currentCandidateId ~= ARGV[3]
  or binding.opaqueLineageHandle ~= ARGV[13]
  or updatedBinding.latestDecisionReceiptHandle ~= ARGV[12]
  or lineageLocator.bindingKey ~= ARGV[17]
  or decisionLocator.bindingKey ~= ARGV[17]
  or decisionLocator.candidateKey ~= ARGV[18]
  or receipt.sourceRef ~= ARGV[12]
  or receipt.subjectRef ~= ARGV[13]
  or receipt.decidedAt ~= score then
  return 'INVALID_ARGUMENTS'
end

local function feedback_matches(existing, incomingRaw)
  if incomingRaw == '' then return existing == nil end
  if existing == nil then return false end
  local ok, submitted = pcall(cjson.decode, incomingRaw)
  if not ok or type(submitted) ~= 'table' then return false end
  return existing.reasonCode == submitted.reasonCode and existing.detail == submitted.detail
end

local receiptStatus = preflight_human_disposition_receipt(
  KEYS[8], KEYS[9], KEYS[10], ARGV[11], ARGV[12], ARGV[13], ARGV[14]
)
if current.state == 'rejected' then
  if not current.humanDispositionLedgerEntry then return 'LEGACY_UNMIGRATED' end
  if current.latestDecisionId ~= ARGV[5]
    or not feedback_matches(current.latestHumanDisposition, ARGV[6]) then
    return 'CONFLICT'
  end
  if redis.call('GET', KEYS[4]) ~= ARGV[7]
    or redis.call('GET', KEYS[5]) ~= ARGV[9]
    or redis.call('GET', KEYS[6]) ~= ARGV[10]
    or receiptStatus ~= 'REPLAY'
    or binding.latestDecisionReceiptHandle ~= ARGV[12]
    or cjson.encode(current.humanDispositionLedgerEntry) ~= cjson.encode(incoming.humanDispositionLedgerEntry) then
    return 'INVARIANT_FAILURE'
  end
  return 'REPLAYED'
end
if current.state ~= 'pending_approval'
  and current.state ~= 'not_now'
  and current.state ~= 'partially_materialized' then
  return 'CONFLICT'
end
if not current.publication or current.publication.state ~= 'anchored' then return 'CONFLICT' end
if redis.call('EXISTS', KEYS[4]) == 1 then return 'BINDING_CONFLICT' end
if redis.call('EXISTS', KEYS[5]) == 1 then return 'LINEAGE_HANDLE_COLLISION' end
if redis.call('EXISTS', KEYS[6]) == 1 then return 'DECISION_RECEIPT_COLLISION' end
if receiptStatus ~= 'NEW' then return 'INVARIANT_FAILURE' end
local subjectStart = tonumber(ARGV[15]) or 0
local subjectCount = tonumber(ARGV[16]) or 0
if subjectCount < 1 or subjectStart < 11 or subjectStart + subjectCount - 1 > #KEYS then
  return 'INVALID_ARGUMENTS'
end

redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[4], ARGV[8])
redis.call('SET', KEYS[5], ARGV[9])
redis.call('SET', KEYS[6], ARGV[10])
for offset = 0, subjectCount - 1 do
  redis.call('SADD', KEYS[subjectStart + offset], ARGV[3])
end
write_human_disposition_receipt(KEYS[8], KEYS[9], KEYS[10], ARGV[11], ARGV[12], score)
return 'UPDATED'
`;
