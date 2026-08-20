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
import { DispatchProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/dispatch-proposal-keys.js';
import {
  computeLegacyNegativeAuthorizationKey,
  computeNegativeAuthorizationKey,
  type NegativeAuthorizationProposalStatus,
} from '../ports/IDispatchProposalStore.js';
import { RedisCanonicalAdmissionBlockedError } from './RedisDispatchProposalCanonicalClaimErrors.js';

export { RedisCanonicalAdmissionBlockedError } from './RedisDispatchProposalCanonicalClaimErrors.js';

/**
 * F167's existing claim script, preceded by broad lineage and canonical
 * decision checks in the same Redis turn. It deliberately checks a prior
 * replay first: retries of an already-claimed carrier keep normal F167
 * idempotency.
 */
const CLAIM_WITH_CANONICAL_ADMISSION_LUA = `
-- canonical-admission-claim
local terminal = redis.call('GET', KEYS[5])
if terminal then return {'subject_terminal', terminal} end
local detailKey = redis.call('GET', KEYS[4])
if detailKey then
  local raw = redis.call('GET', detailKey)
  if raw then
    local current = cjson.decode(raw)
    if current.dispatchId == ARGV[4] then return {'replayed', raw} end
    return {'safe_wait', raw}
  end
  redis.call('DEL', KEYS[4])
end
local targetCatCount = tonumber(ARGV[11])
if not targetCatCount or targetCatCount < 1 or #KEYS ~= 7 + (targetCatCount * 2) then
  return {'canonical_admission_unavailable', 'invalid_negative_authorization_claim'}
end
local detailPrefix = ARGV[1]
local ownerUserId = ARGV[2]
local sourceInvocationId = ARGV[6]
local sourceThreadId = ARGV[7]
local senderCatId = ARGV[8]
local targetThreadId = ARGV[9]

local function proposalTargetsCat(proposalKey, targetCat)
  local targetCatsRaw = redis.call('HGET', proposalKey, 'targetCats')
  local decodedOk, targetCats = pcall(cjson.decode, targetCatsRaw or '[]')
  if not decodedOk or type(targetCats) ~= 'table' then return false end
  for _, candidate in ipairs(targetCats) do
    if candidate == targetCat then return true end
  end
  return false
end

local function appendExactBlocks(blocks)
  for index = 1, targetCatCount do
    local targetCat = ARGV[11 + index]
    local proposalIds = redis.call('ZRANGE', KEYS[7 + index], 0, -1)
    for _, proposalId in ipairs(proposalIds) do
      local proposalKey = detailPrefix .. proposalId
      local status = redis.call('HGET', proposalKey, 'status')
      if (status == 'pending' or status == 'rejected' or status == 'superseded')
        and redis.call('HGET', proposalKey, 'ownerUserId') == ownerUserId
        and redis.call('HGET', proposalKey, 'sourceInvocationId') == sourceInvocationId
        and redis.call('HGET', proposalKey, 'sourceThreadId') == sourceThreadId
        and redis.call('HGET', proposalKey, 'senderCatId') == senderCatId
        and redis.call('HGET', proposalKey, 'targetThreadId') == targetThreadId
        and proposalTargetsCat(proposalKey, targetCat) then
        table.insert(blocks, proposalId)
        table.insert(blocks, status)
        table.insert(blocks, targetCat)
      end
    end
  end
end

local function appendLegacyBlocks(blocks)
  for index = 1, targetCatCount do
    local targetCat = ARGV[11 + index]
    local proposalIds = redis.call('ZRANGE', KEYS[7 + targetCatCount + index], 0, -1)
    for _, proposalId in ipairs(proposalIds) do
      local proposalKey = detailPrefix .. proposalId
      local status = redis.call('HGET', proposalKey, 'status')
      if (status == 'pending' or status == 'rejected' or status == 'superseded')
        and not redis.call('HGET', proposalKey, 'sourceInvocationId')
        and redis.call('HGET', proposalKey, 'ownerUserId') == ownerUserId
        and redis.call('HGET', proposalKey, 'sourceThreadId') == sourceThreadId
        and redis.call('HGET', proposalKey, 'senderCatId') == senderCatId
        and redis.call('HGET', proposalKey, 'targetThreadId') == targetThreadId
        and proposalTargetsCat(proposalKey, targetCat) then
        table.insert(blocks, proposalId)
        table.insert(blocks, status)
        table.insert(blocks, targetCat)
      end
    end
  end
end

-- A first claim is denied by broad lineage authority only after the identity
-- lookup above establishes that this carrier is not a terminal/replay/wait.
local exactBlocks = {}
appendExactBlocks(exactBlocks)
local legacyBlocks = {}
local legacyCutoverAt = nil
local legacyCutoverRaw = redis.call('GET', KEYS[7])
if legacyCutoverRaw then
  legacyCutoverAt = tonumber(legacyCutoverRaw)
  local sourceInvocationCreatedAt = tonumber(ARGV[10])
  if not legacyCutoverAt or legacyCutoverAt <= 0 or not sourceInvocationCreatedAt then
    return {'canonical_admission_unavailable', 'legacy_cutover_invalid'}
  end
  if sourceInvocationCreatedAt <= legacyCutoverAt then appendLegacyBlocks(legacyBlocks) end
end
if #exactBlocks > 0 or #legacyBlocks > 0 then
  local result = {
    'negative_authorization_blocked',
    tostring(#exactBlocks),
    legacyCutoverAt and tostring(legacyCutoverAt) or '',
  }
  for _, value in ipairs(exactBlocks) do table.insert(result, value) end
  for _, value in ipairs(legacyBlocks) do table.insert(result, value) end
  return result
end
if not redis.call('GET', KEYS[2]) then return {'canonical_admission_unavailable', 'projection_not_ready'} end
local proposalIds = redis.call('ZREVRANGE', KEYS[1], 0, 0)
if #proposalIds > 0 then
  local proposalId = proposalIds[1]
  local proposalKey = ARGV[1] .. proposalId
  local status = redis.call('HGET', proposalKey, 'status')
  if (status == 'pending' or status == 'rejected')
    and redis.call('HGET', proposalKey, 'ownerUserId') == ARGV[2]
    and redis.call('HGET', proposalKey, 'canonicalAdmissionActionKey') == ARGV[3] then
    return {'canonical_admission_blocked', proposalId, status}
  end
  return {'canonical_admission_invalid', proposalId}
end
redis.call('SET', KEYS[3], ARGV[5])
redis.call('SET', KEYS[4], KEYS[3])
redis.call('SADD', KEYS[6], KEYS[3])
return {'claimed', ARGV[5]}
`;

export class RedisCanonicalAdmissionUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'RedisCanonicalAdmissionUnavailableError';
  }
}

export type CanonicalAdmissionClaimInput = {
  ownerUserId: string;
  canonicalActionKey: string;
  /** Broad exact/legacy deny authority for a genuinely new structured claim. */
  negativeAuthorization: {
    sourceInvocationId: string;
    sourceThreadId: string;
    senderCatId: string;
    targetThreadId: string;
    targetCats: readonly string[];
    sourceInvocationCreatedAt: number;
  };
  claimInput: ClaimActionSuccessorInput;
};

type CanonicalAdmissionClaimRaw = [string, ...unknown[]];

function decodeClaimRaw(raw: unknown): CanonicalAdmissionClaimRaw {
  if (!Array.isArray(raw) || typeof raw[0] !== 'string') {
    throw new RedisCanonicalAdmissionUnavailableError('canonical admission claim returned an invalid Redis result');
  }
  return raw as CanonicalAdmissionClaimRaw;
}

function decodeCanonicalBlockedClaim(raw: CanonicalAdmissionClaimRaw): never {
  const [, proposalId, status] = raw;
  if (!proposalId || (status !== 'pending' && status !== 'rejected')) {
    throw new RedisCanonicalAdmissionUnavailableError('canonical admission claim returned an invalid blocker');
  }
  throw new RedisCanonicalAdmissionBlockedError([{ proposalId: String(proposalId), status }]);
}

function decodeNegativeAuthorizationBlockedClaim(raw: CanonicalAdmissionClaimRaw): never {
  const exactValueCountRaw = raw[1];
  const legacyCutoverAtRaw = raw[2];
  const encodedBlocks = raw.slice(3);
  const exactValueCount =
    typeof exactValueCountRaw === 'string' && /^\d+$/.test(exactValueCountRaw) ? Number(exactValueCountRaw) : NaN;
  if (
    encodedBlocks.length === 0 ||
    encodedBlocks.length % 3 !== 0 ||
    !Number.isSafeInteger(exactValueCount) ||
    exactValueCount < 0 ||
    exactValueCount > encodedBlocks.length ||
    exactValueCount % 3 !== 0
  ) {
    throw new RedisCanonicalAdmissionUnavailableError('canonical admission claim returned an invalid broad blocker');
  }
  const legacyBlockPresent = exactValueCount < encodedBlocks.length;
  const legacyUnresolved = exactValueCount === 0 && legacyBlockPresent;
  const legacyCutoverAt =
    typeof legacyCutoverAtRaw === 'string' && legacyCutoverAtRaw.length > 0 ? Number(legacyCutoverAtRaw) : undefined;
  if (
    legacyBlockPresent &&
    (typeof legacyCutoverAt !== 'number' || !Number.isFinite(legacyCutoverAt) || legacyCutoverAt <= 0)
  ) {
    throw new RedisCanonicalAdmissionUnavailableError('canonical admission claim returned an invalid legacy cutover');
  }
  const blocksByProposalId = new Map<string, NegativeAuthorizationProposalStatus>();
  for (let index = 0; index < encodedBlocks.length; index += 3) {
    const proposalId = encodedBlocks[index];
    const status = encodedBlocks[index + 1];
    const targetCat = encodedBlocks[index + 2];
    if (
      typeof proposalId !== 'string' ||
      typeof targetCat !== 'string' ||
      (status !== 'pending' && status !== 'rejected' && status !== 'superseded')
    ) {
      throw new RedisCanonicalAdmissionUnavailableError('canonical admission claim returned an invalid broad blocker');
    }
    const existing = blocksByProposalId.get(proposalId);
    if (existing && existing !== status) {
      throw new RedisCanonicalAdmissionUnavailableError(
        'canonical admission claim returned conflicting broad blockers',
      );
    }
    blocksByProposalId.set(proposalId, status);
  }
  throw new RedisCanonicalAdmissionBlockedError(
    [...blocksByProposalId.entries()]
      .map(([proposalId, status]) => ({ proposalId, status }))
      .sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
    legacyUnresolved,
    legacyBlockPresent ? legacyCutoverAt : undefined,
    legacyBlockPresent,
  );
}

function decodeLeaseClaim(
  raw: CanonicalAdmissionClaimRaw,
  claimInput: ClaimActionSuccessorInput,
): ActionSuccessorClaimStoreResult {
  const [outcome, payload] = raw;
  if (outcome === 'canonical_admission_blocked') return decodeCanonicalBlockedClaim(raw);
  if (outcome === 'negative_authorization_blocked') return decodeNegativeAuthorizationBlockedClaim(raw);
  if (outcome === 'canonical_admission_invalid' || outcome === 'canonical_admission_unavailable') {
    throw new RedisCanonicalAdmissionUnavailableError(
      `canonical admission claim unavailable: ${String(payload)}`,
      outcome === 'canonical_admission_unavailable' && typeof payload === 'string' ? payload : undefined,
    );
  }
  if (typeof payload !== 'string') {
    throw new RedisCanonicalAdmissionUnavailableError('canonical admission claim returned a missing lease payload');
  }
  if (outcome === 'subject_terminal') {
    const terminal = parseActionSubjectTerminal(payload);
    if (!terminal) throw new RedisCanonicalAdmissionUnavailableError('missing action subject terminal payload');
    return { outcome, terminal };
  }
  const lease = parseActionSuccessorLease(payload);
  if (!lease) throw new RedisCanonicalAdmissionUnavailableError('missing action successor lease payload');
  if (outcome === 'replayed') return claimActionSuccessor(lease, claimInput);
  if (outcome === 'claimed' || outcome === 'safe_wait') return { outcome, lease };
  throw new RedisCanonicalAdmissionUnavailableError(`unexpected canonical admission claim outcome: ${outcome}`);
}

function claimError(message: unknown): RedisCanonicalAdmissionUnavailableError {
  return new RedisCanonicalAdmissionUnavailableError(
    `canonical admission claim failed closed: ${message instanceof Error ? message.message : String(message)}`,
  );
}

export async function claimRedisActionSuccessorWithCanonicalAdmission(
  redis: RedisClient,
  input: CanonicalAdmissionClaimInput,
): Promise<ActionSuccessorClaimStoreResult> {
  try {
    const candidate = claimActionSuccessor(null, input.claimInput).lease;
    const targetCats = [...new Set(input.negativeAuthorization.targetCats)].sort();
    if (targetCats.length === 0) {
      throw new RedisCanonicalAdmissionUnavailableError('canonical admission claim requires at least one target cat');
    }
    const exactIndexKeys = targetCats.map((targetCat) =>
      DispatchProposalKeys.negativeAuthorization(
        computeNegativeAuthorizationKey(
          input.ownerUserId,
          input.negativeAuthorization.sourceInvocationId,
          input.negativeAuthorization.targetThreadId,
          targetCat,
        ),
      ),
    );
    const legacyIndexKeys = targetCats.map((targetCat) =>
      DispatchProposalKeys.legacyNegativeAuthorization(
        computeLegacyNegativeAuthorizationKey(
          input.ownerUserId,
          input.negativeAuthorization.sourceThreadId,
          input.negativeAuthorization.senderCatId,
          input.negativeAuthorization.targetThreadId,
          targetCat,
        ),
      ),
    );
    const raw = await redis.eval(
      CLAIM_WITH_CANONICAL_ADMISSION_LUA,
      7 + exactIndexKeys.length + legacyIndexKeys.length,
      DispatchProposalKeys.canonicalAdmissionAction(input.canonicalActionKey),
      DispatchProposalKeys.canonicalAdmissionRebuildCompletedAt,
      ActionSuccessorKeys.detail(candidate.leaseId),
      ActionSuccessorKeys.identity(candidate),
      ActionSuccessorKeys.subjectTerminal(candidate.subjectRef),
      ActionSuccessorKeys.ALL,
      DispatchProposalKeys.negativeAuthorizationLegacyCutover,
      ...exactIndexKeys,
      ...legacyIndexKeys,
      `${redis.options.keyPrefix ?? ''}${DispatchProposalKeys.detailPrefix}`,
      input.ownerUserId,
      input.canonicalActionKey,
      candidate.dispatchId,
      JSON.stringify(candidate),
      input.negativeAuthorization.sourceInvocationId,
      input.negativeAuthorization.sourceThreadId,
      input.negativeAuthorization.senderCatId,
      input.negativeAuthorization.targetThreadId,
      String(input.negativeAuthorization.sourceInvocationCreatedAt),
      String(targetCats.length),
      ...targetCats,
    );
    return decodeLeaseClaim(decodeClaimRaw(raw), input.claimInput);
  } catch (error) {
    if (
      error instanceof RedisCanonicalAdmissionBlockedError ||
      error instanceof RedisCanonicalAdmissionUnavailableError
    ) {
      throw error;
    }
    throw claimError(error);
  }
}
