import type { DispatchProposal } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { DispatchProposalKeys } from '../../../cats/services/stores/redis-keys/proposals/dispatch-proposal-keys.js';
import {
  type CreateDispatchProposalInput,
  type CreateDispatchProposalResult,
  computeLegacyNegativeAuthorizationKey,
  computeLineageKey,
  computeNegativeAuthorizationKey,
} from '../ports/IDispatchProposalStore.js';
import {
  canonicalAdmissionIndexKeysForProposal,
  canonicalAdmissionStoredFields,
} from './RedisDispatchProposalCanonicalAdmission.js';
import { hydrateDispatchProposal, serializeDispatchProposal } from './RedisDispatchProposalSerde.js';

/**
 * Atomic create is the sole mutation boundary for dispatch admission:
 * dedup claim, staged-holder fence, lazy backfill, supersession, and indexing.
 */
const CAS_CREATE_LINEAGE_LUA = `
  local lineageKey = KEYS[1]
  local pendingKey = KEYS[2]
  local newHashKey = KEYS[3]
  local newId = ARGV[1]
  local createdAt = ARGV[2]
  local oldCount = tonumber(ARGV[3])
  local keyBase = string.sub(newHashKey, 1, #newHashKey - #newId)

  local function removeCanonicalAdmissionIndexes(proposalId)
    local proposalKey = keyBase .. proposalId
    local actionIndexKey = redis.call('HGET', proposalKey, 'canonicalAdmissionActionIndexKey')
    local subjectIndexKey = redis.call('HGET', proposalKey, 'canonicalAdmissionSubjectIndexKey')
    if actionIndexKey then redis.call('ZREM', actionIndexKey, proposalId) end
    if subjectIndexKey then redis.call('ZREM', subjectIndexKey, proposalId) end
  end

  local hasDedup = ARGV[4] == '1'
  if hasDedup then
    local existingId = redis.call('GET', KEYS[4])
    if existingId then
      local existingStatus = redis.call('HGET', keyBase .. existingId, 'status')
      if existingStatus then return {'DEDUP', existingId} end
    end
  end

  local publicationHolder = redis.call('GET', lineageKey)
  if not publicationHolder and oldCount > 0 then
    publicationHolder = ARGV[5]
  end
  if publicationHolder and publicationHolder ~= newId then
    local holderKey = keyBase .. publicationHolder
    local holderStatus = redis.call('HGET', holderKey, 'status')
    local holderPublicationRaw = redis.call('HGET', holderKey, 'publication')
    if holderStatus == 'pending' and holderPublicationRaw then
      local publicationOk, holderPublication = pcall(cjson.decode, holderPublicationRaw)
      if publicationOk and holderPublication.state == 'staged' then
        return {'LINEAGE_BUSY', publicationHolder}
      end
    end
  end

  local canonicalIndexCount = tonumber(ARGV[5 + oldCount])
  local fieldStart = 6 + oldCount
  local fieldArgs = {}
  for i = fieldStart, #ARGV do
    fieldArgs[#fieldArgs + 1] = ARGV[i]
  end
  if #fieldArgs > 0 then redis.call('HMSET', newHashKey, unpack(fieldArgs)) end

  local superseded = {}
  local existingLineage = redis.call('GET', lineageKey)
  if not existingLineage and oldCount > 0 then
    local keeperId = ARGV[5]
    redis.call('SET', lineageKey, keeperId)
    existingLineage = keeperId
    for i = 1, oldCount - 1 do
      local staleId = ARGV[5 + i]
      local staleKey = keyBase .. staleId
      if redis.call('HGET', staleKey, 'status') == 'pending' then
        redis.call('HSET', staleKey, 'status', 'superseded', 'supersededBy', keeperId)
        redis.call('ZREM', pendingKey, staleId)
        removeCanonicalAdmissionIndexes(staleId)
        superseded[#superseded + 1] = staleId
      end
    end
  end

  existingLineage = redis.call('GET', lineageKey)
  if existingLineage and existingLineage ~= newId then
    local oldKey = keyBase .. existingLineage
    if redis.call('HGET', oldKey, 'status') == 'pending' then
      redis.call('HSET', oldKey, 'status', 'superseded', 'supersededBy', newId)
      redis.call('ZREM', pendingKey, existingLineage)
      removeCanonicalAdmissionIndexes(existingLineage)
      superseded[#superseded + 1] = existingLineage
    end
  end

  redis.call('ZADD', pendingKey, tonumber(createdAt), newId)
  redis.call('SET', lineageKey, newId)
  if hasDedup then redis.call('SET', KEYS[4], newId) end
  local negativeAuthorizationKeyStart = hasDedup and 5 or 4
  local canonicalIndexKeyStart = #KEYS - canonicalIndexCount + 1
  for i = negativeAuthorizationKeyStart, canonicalIndexKeyStart - 1 do
    redis.call('ZADD', KEYS[i], tonumber(createdAt), newId)
  end
  for i = canonicalIndexKeyStart, #KEYS do
    redis.call('ZADD', KEYS[i], tonumber(createdAt), newId)
  end
  if #superseded > 0 then
    redis.call('HSET', newHashKey, 'supersededProposalIds', cjson.encode(superseded))
  end
  return superseded
`;

async function loadProposal(redis: RedisClient, proposalId: string): Promise<DispatchProposal | null> {
  const raw = await redis.hgetall(DispatchProposalKeys.detail(proposalId));
  if (!raw || Object.keys(raw).length === 0) return null;
  return hydrateDispatchProposal(raw);
}

/** Derived projection only: ids in these sets are revalidated against the hash on read. */
export function negativeAuthorizationRedisKeysForProposal(proposal: DispatchProposal): string[] {
  if (!proposal.sourceInvocationId) return [];
  return [...new Set(proposal.targetCats)].map((targetCat) =>
    DispatchProposalKeys.negativeAuthorization(
      computeNegativeAuthorizationKey(
        proposal.ownerUserId,
        proposal.sourceInvocationId as string,
        proposal.targetThreadId,
        targetCat,
      ),
    ),
  );
}

/** Unresolved legacy records never enter the exact index; their lookup is cutover-bounded. */
export function legacyNegativeAuthorizationRedisKeysForProposal(proposal: DispatchProposal): string[] {
  if (proposal.sourceInvocationId) return [];
  return [...new Set(proposal.targetCats)].map((targetCat) =>
    DispatchProposalKeys.legacyNegativeAuthorization(
      computeLegacyNegativeAuthorizationKey(
        proposal.ownerUserId,
        proposal.sourceThreadId,
        proposal.senderCatId,
        proposal.targetThreadId,
        targetCat,
      ),
    ),
  );
}

async function resolveDedup(
  redis: RedisClient,
  input: CreateDispatchProposalInput,
): Promise<{ redisKey: string | null; existing: DispatchProposal | null }> {
  if (!input.clientMessageId) return { redisKey: null, existing: null };
  const redisKey = DispatchProposalKeys.clientMsg(input.sourceThreadId, input.clientMessageId);
  const existingId = await redis.get(redisKey);
  return {
    redisKey,
    existing: existingId ? await loadProposal(redis, existingId) : null,
  };
}

async function findBackfillCandidateIds(
  redis: RedisClient,
  input: CreateDispatchProposalInput,
  lineage: string,
  lineageRedisKey: string,
): Promise<string[]> {
  if (await redis.get(lineageRedisKey)) return [];
  const ids = await redis.zrevrange(DispatchProposalKeys.userPending(input.ownerUserId), 0, -1);
  if (ids.length === 0) return [];
  const pipeline = redis.pipeline();
  for (const id of ids) pipeline.hgetall(DispatchProposalKeys.detail(id));
  const rows = await pipeline.exec();
  if (!rows) return [];
  return rows
    .flatMap(([error, raw]) => {
      if (error || !raw || typeof raw !== 'object' || Object.keys(raw as Record<string, string>).length === 0) {
        return [];
      }
      const proposal = hydrateDispatchProposal(raw as Record<string, string>);
      return proposal.status === 'pending' &&
        computeLineageKey(proposal.sourceThreadId, proposal.targetThreadId, proposal.senderCatId) === lineage
        ? [proposal]
        : [];
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((proposal) => proposal.proposalId);
}

async function resolveAtomicCollision(redis: RedisClient, result: unknown): Promise<DispatchProposal | null> {
  if (!Array.isArray(result) || result.length < 2 || (result[0] !== 'DEDUP' && result[0] !== 'LINEAGE_BUSY')) {
    return null;
  }
  const existingId = result[1] as string;
  const existing = await loadProposal(redis, existingId);
  if (existing) return existing;
  throw new Error(`dispatch proposal ${result[0]} target vanished after atomic create fence: ${existingId}`);
}

async function loadSuperseded(redis: RedisClient, result: unknown): Promise<DispatchProposal[]> {
  if (!Array.isArray(result)) return [];
  const proposals = await Promise.all((result as string[]).map((proposalId) => loadProposal(redis, proposalId)));
  return proposals.filter((proposal): proposal is DispatchProposal => proposal !== null);
}

export async function createRedisDispatchProposal(
  redis: RedisClient,
  input: CreateDispatchProposalInput,
): Promise<CreateDispatchProposalResult> {
  const proposal: DispatchProposal = {
    ...input,
    effectClass: 'assign_work',
    status: 'pending',
    publication: { state: 'staged', stagedAt: input.createdAt },
  };
  const dedup = await resolveDedup(redis, input);
  if (dedup.existing) {
    return { proposal: dedup.existing, supersededProposals: [] };
  }

  const lineage = computeLineageKey(input.sourceThreadId, input.targetThreadId, input.senderCatId);
  const lineageRedisKey = DispatchProposalKeys.lineage(lineage);
  const pendingRedisKey = DispatchProposalKeys.userPending(input.ownerUserId);
  const detailRedisKey = DispatchProposalKeys.detail(input.proposalId);
  const negativeAuthorizationRedisKeys = negativeAuthorizationRedisKeysForProposal(proposal);
  const canonicalAdmissionRedisKeys = canonicalAdmissionIndexKeysForProposal(proposal);
  const canonicalAdmissionFields = canonicalAdmissionStoredFields(redis, proposal);
  const oldCandidateIds = await findBackfillCandidateIds(redis, input, lineage, lineageRedisKey);
  const redisKeys = dedup.redisKey
    ? [
        lineageRedisKey,
        pendingRedisKey,
        detailRedisKey,
        dedup.redisKey,
        ...negativeAuthorizationRedisKeys,
        ...canonicalAdmissionRedisKeys,
      ]
    : [
        lineageRedisKey,
        pendingRedisKey,
        detailRedisKey,
        ...negativeAuthorizationRedisKeys,
        ...canonicalAdmissionRedisKeys,
      ];
  const result = await redis.eval(
    CAS_CREATE_LINEAGE_LUA,
    redisKeys.length,
    ...redisKeys,
    input.proposalId,
    String(input.createdAt),
    String(oldCandidateIds.length),
    dedup.redisKey ? '1' : '0',
    ...oldCandidateIds,
    String(canonicalAdmissionRedisKeys.length),
    ...serializeDispatchProposal(proposal),
    ...canonicalAdmissionFields,
  );
  const collision = await resolveAtomicCollision(redis, result);
  if (collision) return { proposal: collision, supersededProposals: [] };
  return {
    proposal,
    supersededProposals: await loadSuperseded(redis, result),
  };
}
