import { HUMAN_DISPOSITION_RECEIPT_FUNCTIONS_LUA } from '../../human-disposition/human-disposition-lua.js';
import { PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA } from './person-memory-disposition-lua-preflight.js';

export const F276_DISPOSITION_VALIDATION_LUA = `
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
  if feedback.reasonCode == 'other' then
    return exact_fields(feedback, { reasonCode = true, detail = true }, 2)
      and type(feedback.detail) == 'string' and feedback.detail ~= ''
  end
  return exact_fields(feedback, { reasonCode = true }, 1)
    and (feedback.reasonCode == 'not_important' or feedback.reasonCode == 'wrong_lane'
      or feedback.reasonCode == 'bad_evidence' or feedback.reasonCode == 'wrong')
end
local function valid_f276_entry(entry, binding, source_ref, subject_ref, score, feedback)
  local has_feedback = feedback ~= nil
  if not exact_fields(entry, { episode = true, envelope = true }, has_feedback and 2 or 1) then return false end
  local episode = entry.episode
  local episode_fields = {
    interactionKind = true, subjectRef = true, proposalId = true, decision = true,
    producerCatId = true, ownerUserId = true, decidedAt = true, sourceRef = true, feedback = true
  }
  if not exact_fields(episode, episode_fields, has_feedback and 9 or 8)
    or episode.interactionKind ~= 'person_memory_proposal'
    or episode.subjectRef ~= subject_ref
    or episode.proposalId ~= binding.currentOpaqueProposalHandle
    or episode.decision ~= 'rejected'
    or type(episode.producerCatId) ~= 'string' or episode.producerCatId == ''
    or episode.ownerUserId ~= binding.ownerUserId
    or episode.decidedAt ~= score or episode.sourceRef ~= source_ref then
    return false
  end
  if not has_feedback then return episode.feedback == nil and entry.envelope == nil end
  if not valid_feedback(episode.feedback)
    or episode.feedback.reasonCode ~= feedback.reasonCode
    or episode.feedback.detail ~= feedback.detail then return false end
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
    and exact_fields(envelope.scope, { kind = true, rootProposalId = true }, 2)
    and envelope.scope.kind == 'proposal_lineage'
    and envelope.scope.rootProposalId == subject_ref
    and exact_fields(envelope.expiry, { kind = true }, 1) and envelope.expiry.kind == 'none'
    and exact_fields(envelope.invalidator, { kind = true, supersessionKey = true }, 2)
    and envelope.invalidator.kind == 'source_superseded'
    and envelope.invalidator.supersessionKey == binding.currentOpaqueSupersessionHandle
end
`;

export const REJECT_DISPOSITION_CANDIDATE_LUA = `
${PERSON_MEMORY_DISPOSITION_PREFLIGHT_LUA}
${HUMAN_DISPOSITION_RECEIPT_FUNCTIONS_LUA}
${F276_DISPOSITION_VALIDATION_LUA}
if #KEYS < 11 or #ARGV ~= 19 then return 'INVALID_ARGUMENTS' end
if not allowed_type(KEYS[1], 'string')
  or not allowed_type(KEYS[2], 'zset')
  or not allowed_type(KEYS[3], 'string')
  or not allowed_type(KEYS[4], 'string')
  or not allowed_type(KEYS[5], 'string')
  or not allowed_type(KEYS[6], 'string')
  or not allowed_type(KEYS[7], 'set')
  or not allowed_type(KEYS[8], 'string')
  or not allowed_type(KEYS[9], 'hash')
  or not allowed_type(KEYS[10], 'zset')
  or not allowed_type(KEYS[11], 'zset') then
  return 'TYPE_CONFLICT'
end
for index = 12, #KEYS do
  if not allowed_type(KEYS[index], 'set') then return 'TYPE_CONFLICT' end
end
if redis.call('EXISTS', KEYS[8]) == 1 then return 'NOT_AVAILABLE' end
local score = finite_number(ARGV[14])
if not score
  or not valid_json(ARGV[2])
  or not valid_json(ARGV[4])
  or not valid_json(ARGV[7])
  or not valid_json(ARGV[8])
  or not valid_json(ARGV[9])
  or not valid_json(ARGV[10])
  or not valid_json(ARGV[11])
  or not valid_json(ARGV[17]) then
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
local closure = cjson.decode(ARGV[17])
local feedback = nil
if ARGV[6] ~= '' then
  local feedbackOk, decodedFeedback = pcall(cjson.decode, ARGV[6])
  if not feedbackOk or not valid_feedback(decodedFeedback) then return 'INVALID_ARGUMENTS' end
  feedback = decodedFeedback
end
local entryFeedback = feedback
if current.state == 'rejected' then entryFeedback = current.latestHumanDisposition end
if not exact_fields(binding, {
    version = true, ownerUserId = true, closurePersonId = true, rootCandidateId = true,
    currentCandidateId = true, opaqueLineageHandle = true, currentOpaqueProposalHandle = true,
    currentOpaqueSupersessionHandle = true, latestDecisionReceiptHandle = true
  }, binding.latestDecisionReceiptHandle and 9 or 8)
  or not exact_fields(updatedBinding, {
    version = true, ownerUserId = true, closurePersonId = true, rootCandidateId = true,
    currentCandidateId = true, opaqueLineageHandle = true, currentOpaqueProposalHandle = true,
    currentOpaqueSupersessionHandle = true, latestDecisionReceiptHandle = true
  }, 9)
  or not exact_fields(lineageLocator, { bindingKey = true, closurePersonId = true }, 2)
  or not exact_fields(decisionLocator, { bindingKey = true, candidateKey = true, closurePersonId = true }, 3)
  or not exact_fields(closure, { membershipChecks = true, artifactMembers = true }, 2)
  or not valid_f276_entry(
    incoming.humanDispositionLedgerEntry, updatedBinding, ARGV[12], ARGV[13], score, entryFeedback
  )
  or (current.state ~= 'rejected' and (
    incoming.latestDecisionId ~= ARGV[5]
    or (feedback == nil and incoming.latestHumanDisposition ~= nil)
    or (feedback ~= nil and (not valid_feedback(incoming.latestHumanDisposition)
      or incoming.latestHumanDisposition.reasonCode ~= feedback.reasonCode
      or incoming.latestHumanDisposition.detail ~= feedback.detail))
  )) then
  return 'INVALID_ARGUMENTS'
end
if redis.call('GET', KEYS[4]) ~= ARGV[7] or redis.call('GET', KEYS[5]) ~= ARGV[9] then
  return 'BINDING_CONFLICT'
end
if binding.currentCandidateId ~= ARGV[3]
  or binding.opaqueLineageHandle ~= ARGV[13]
  or updatedBinding.latestDecisionReceiptHandle ~= ARGV[12]
  or lineageLocator.bindingKey ~= ARGV[18]
  or decisionLocator.bindingKey ~= ARGV[18]
  or decisionLocator.candidateKey ~= ARGV[19]
  or receipt.sourceRef ~= ARGV[12]
  or receipt.subjectRef ~= ARGV[13]
  or receipt.decidedAt ~= score then
  return 'INVALID_ARGUMENTS'
end
for _, check in ipairs(closure.membershipChecks or {}) do
  if type(check.keyIndex) ~= 'number' or check.keyIndex < 12 or check.keyIndex > #KEYS
    or type(check.member) ~= 'string'
    or redis.call('SISMEMBER', KEYS[check.keyIndex], check.member) ~= 1 then
    return 'CLOSURE_CONFLICT'
  end
end
for _, member in ipairs(closure.artifactMembers or {}) do
  if type(member) ~= 'string' or redis.call('SISMEMBER', KEYS[7], member) ~= 1 then
    return 'CLOSURE_CONFLICT'
  end
end

local function feedback_matches(existing, incomingRaw)
  if incomingRaw == '' then return existing == nil end
  if existing == nil then return false end
  local ok, submitted = pcall(cjson.decode, incomingRaw)
  if not ok or type(submitted) ~= 'table' then return false end
  return existing.reasonCode == submitted.reasonCode and existing.detail == submitted.detail
end

local receiptStatus = preflight_human_disposition_receipt(
  KEYS[9], KEYS[10], KEYS[11], ARGV[11], ARGV[12], ARGV[13], ARGV[14]
)
if current.state == 'rejected' then
  if not current.humanDispositionLedgerEntry then return 'LEGACY_UNMIGRATED' end
  if current.latestDecisionId ~= ARGV[5]
    or not feedback_matches(current.latestHumanDisposition, ARGV[6]) then
    return 'CONFLICT'
  end
  if receiptStatus ~= 'REPLAY'
    or redis.call('GET', KEYS[6]) ~= ARGV[10]
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
if receiptStatus ~= 'NEW' then return 'INVARIANT_FAILURE' end
if redis.call('EXISTS', KEYS[6]) == 1 then return 'DECISION_RECEIPT_COLLISION' end
local subjectStart = tonumber(ARGV[15]) or 0
local subjectCount = tonumber(ARGV[16]) or 0
if subjectCount < 1 or subjectStart < 12 or subjectStart + subjectCount - 1 > #KEYS then
  return 'INVALID_ARGUMENTS'
end

redis.call('SET', KEYS[1], ARGV[2])
redis.call('ZREM', KEYS[2], ARGV[3])
redis.call('SET', KEYS[3], ARGV[4])
redis.call('SET', KEYS[4], ARGV[8])
redis.call('SET', KEYS[6], ARGV[10])
redis.call('SADD', KEYS[7], KEYS[3], KEYS[6])
for offset = 0, subjectCount - 1 do
  redis.call('SADD', KEYS[subjectStart + offset], ARGV[3])
end
write_human_disposition_receipt(KEYS[9], KEYS[10], KEYS[11], ARGV[11], ARGV[12], score)
return 'UPDATED'
`;
