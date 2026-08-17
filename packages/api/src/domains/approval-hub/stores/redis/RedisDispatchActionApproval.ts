import type { DispatchProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ActionSuccessorClaimStoreResult } from '../../../ball-custody/ActionSuccessorLeaseStore.js';
import { ActionSuccessorKeys } from '../../../ball-custody/action-successor-keys.js';
import {
  parseActionSubjectTerminal,
  parseActionSuccessorLease,
} from '../../../ball-custody/action-successor-redis-codecs.js';
import {
  type ClaimActionSuccessorInput,
  claimActionSuccessor,
} from '../../../ball-custody/action-successor-state-machine.js';
import { type OwnerAuthProvenance, requireOwnerAuthProvenance } from '../../../cats/services/owner-auth-provenance.js';
import { DispatchProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/dispatch-proposal-keys.js';

const APPROVE_AND_CLAIM_ACTION_LUA = `
local proposalKey = KEYS[1]
local pendingKey = KEYS[2]
local settledKey = KEYS[3]
local candidateDetailKey = KEYS[4]
local identityKey = KEYS[5]
local terminalKey = KEYS[6]
local allLeasesKey = KEYS[7]

local function sameHolders(left, right)
  if #left ~= #right then return false end
  local seen = {}
  for _, value in ipairs(left) do seen[value] = true end
  for _, value in ipairs(right) do
    if not seen[value] then return false end
  end
  return true
end

local function sameClaim(current, candidate)
  local currentDigest = current.terminalPredicate and current.terminalPredicate.digest or nil
  local candidateDigest = candidate.terminalPredicate and candidate.terminalPredicate.digest or nil
  return current.dispatchId == candidate.dispatchId
    and current.mode == candidate.mode
    and current.parallelIntent == candidate.parallelIntent
    and current.claimOrigin == candidate.claimOrigin
    and current.holderThreadId == candidate.holderThreadId
    and current.predecessorCatId == candidate.predecessorCatId
    and current.predecessorThreadId == candidate.predecessorThreadId
    and current.issuerStandingEvidenceRef == candidate.issuerStandingEvidenceRef
    and currentDigest == candidateDigest
    and sameHolders(current.holderCatIds or {}, candidate.holderCatIds or {})
end

local function actionRef(lease)
  return cjson.encode({
    leaseId = lease.leaseId,
    generation = lease.generation,
    dispatchId = lease.dispatchId,
    terminalPredicateDigest = lease.terminalPredicate.digest
  })
end

if redis.call('EXISTS', proposalKey) ~= 1 then return {'proposal_missing', ''} end
if redis.call('HGET', proposalKey, 'ownerUserId') ~= ARGV[2] then
  return {'not_authorized', ''}
end
if redis.call('HGET', proposalKey, 'envelopeDigest') ~= ARGV[6] then
  return {'proposal_integrity_error', ''}
end

local status = redis.call('HGET', proposalKey, 'status')
if status == 'approved' then
  local refRaw = redis.call('HGET', proposalKey, 'actionLeaseRef')
  local detailKey = redis.call('GET', identityKey)
  local leaseRaw = detailKey and redis.call('GET', detailKey) or nil
  if not refRaw or not leaseRaw then return {'proposal_integrity_error', ''} end
  local ref = cjson.decode(refRaw)
  local lease = cjson.decode(leaseRaw)
  if ref.leaseId ~= lease.leaseId or ref.generation ~= lease.generation or lease.dispatchId ~= ARGV[4] then
    return {'proposal_integrity_error', ''}
  end
  return {'replayed', leaseRaw}
end
if status ~= 'pending' then return {'proposal_not_pending', status or ''} end

local terminal = redis.call('GET', terminalKey)
if terminal then return {'subject_terminal', terminal} end

local candidate = cjson.decode(ARGV[5])
local outcome = 'claimed'
local leaseRaw = ARGV[5]
local detailKey = redis.call('GET', identityKey)
if detailKey then
  local existingRaw = redis.call('GET', detailKey)
  if existingRaw then
    local current = cjson.decode(existingRaw)
    if current.dispatchId ~= ARGV[4] then return {'safe_wait', existingRaw} end
    if not sameClaim(current, candidate) then return {'replay_mismatch', existingRaw} end
    outcome = 'replayed'
    leaseRaw = existingRaw
  else
    redis.call('DEL', identityKey)
    detailKey = nil
  end
end

if not detailKey then
  redis.call('SET', candidateDetailKey, ARGV[5])
  redis.call('SET', identityKey, candidateDetailKey)
  redis.call('SADD', allLeasesKey, candidateDetailKey)
end

local lease = cjson.decode(leaseRaw)
local canonicalActionIndexKey = redis.call('HGET', proposalKey, 'canonicalAdmissionActionIndexKey')
local canonicalSubjectIndexKey = redis.call('HGET', proposalKey, 'canonicalAdmissionSubjectIndexKey')
if canonicalActionIndexKey then redis.call('ZREM', canonicalActionIndexKey, ARGV[3]) end
if canonicalSubjectIndexKey then redis.call('ZREM', canonicalSubjectIndexKey, ARGV[3]) end
redis.call('HSET', proposalKey,
  'status', 'approved',
  'decidedAt', ARGV[1],
  'decidedBy', ARGV[2],
  'approvalOwnerAuthProvenance', ARGV[7],
  'actionLeaseRef', actionRef(lease))
redis.call('ZREM', pendingKey, ARGV[3])
redis.call('ZADD', settledKey, ARGV[1], ARGV[3])
return {outcome, leaseRaw}
`;

export class RedisDispatchActionApprovalError extends Error {
  constructor(
    readonly code: 'proposal_missing' | 'not_authorized' | 'proposal_integrity_error' | 'proposal_not_pending',
    message: string,
  ) {
    super(message);
    this.name = 'RedisDispatchActionApprovalError';
  }
}

export async function approveRedisDispatchProposalWithActionClaim(
  redis: RedisClient,
  proposal: DispatchProposal,
  userId: string,
  ownerAuthProvenance: OwnerAuthProvenance,
  input: ClaimActionSuccessorInput,
): Promise<ActionSuccessorClaimStoreResult> {
  if (!proposal.proposedAction || !proposal.envelopeDigest) {
    throw new RedisDispatchActionApprovalError(
      'proposal_integrity_error',
      'dispatch proposal is missing its validated action envelope',
    );
  }
  const base = claimActionSuccessor(null, input).lease;
  const candidate = {
    ...base,
    dispatchDeliveryState: 'pending' as const,
    dispatchDeliveryAttemptCount: 0,
  };
  const provenance = requireOwnerAuthProvenance(ownerAuthProvenance);
  const raw = (await redis.eval(
    APPROVE_AND_CLAIM_ACTION_LUA,
    7,
    DispatchProposalKeys.detail(proposal.proposalId),
    DispatchProposalKeys.userPending(proposal.ownerUserId),
    DispatchProposalKeys.userSettled(proposal.ownerUserId),
    ActionSuccessorKeys.detail(candidate.leaseId),
    ActionSuccessorKeys.identity(candidate),
    ActionSuccessorKeys.subjectTerminal(candidate.subjectRef),
    ActionSuccessorKeys.ALL,
    String(input.now),
    userId,
    proposal.proposalId,
    input.dispatchId,
    JSON.stringify(candidate),
    proposal.envelopeDigest,
    provenance,
  )) as [string, string];
  const [outcome, payload] = raw;
  if (outcome === 'subject_terminal') {
    const terminal = parseActionSubjectTerminal(payload);
    if (!terminal) throw new Error('missing action subject terminal payload');
    return { outcome, terminal };
  }
  if (
    outcome === 'proposal_missing' ||
    outcome === 'not_authorized' ||
    outcome === 'proposal_integrity_error' ||
    outcome === 'proposal_not_pending'
  ) {
    throw new RedisDispatchActionApprovalError(outcome, `dispatch action approval rejected: ${outcome}`);
  }
  const lease = parseActionSuccessorLease(payload);
  if (!lease) throw new Error('missing action successor lease payload');
  if (outcome === 'replayed') return claimActionSuccessor(lease, input);
  if (outcome !== 'claimed' && outcome !== 'safe_wait' && outcome !== 'replay_mismatch') {
    throw new Error(`unexpected dispatch action approval outcome: ${outcome}`);
  }
  return { outcome, lease };
}
