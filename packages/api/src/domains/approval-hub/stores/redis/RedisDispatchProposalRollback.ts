import type { RedisClient } from '@cat-cafe/shared/utils';

const ABORT_STAGED_DISPATCH_LUA = `
  local failedKey = KEYS[1]
  local pendingKey = KEYS[2]
  local lineageKey = KEYS[3]
  local failedId = ARGV[1]
  local hasConditionalDeleteKey = ARGV[2] == '1'
  local settledKey = KEYS[4]
  local conditionalDeleteKey = hasConditionalDeleteKey and KEYS[5] or nil
  local negativeAuthorizationKeyStart = hasConditionalDeleteKey and 6 or 5

  local raw = redis.call('HGET', failedKey, 'publication')
  if not raw then return 0 end
  local ok, current = pcall(cjson.decode, raw)
  if not ok or current.state ~= 'staged' then return 0 end

  local rawPredecessors = redis.call('HGET', failedKey, 'supersededProposalIds')
  local predecessors = {}
  if rawPredecessors then
    local predOk, decoded = pcall(cjson.decode, rawPredecessors)
    if predOk and type(decoded) == 'table' then
      predecessors = decoded
    end
  end
  local deliveryPredecessors = {}
  local deliveryRaw = redis.call('HGET', failedKey, 'deliveryRollbackPredecessorIds')
  if deliveryRaw then
    local deliveryOk, decoded = pcall(cjson.decode, deliveryRaw)
    if not deliveryOk or type(decoded) ~= 'table' then return redis.error_reply('invalid rollback custody') end
    deliveryPredecessors = decoded
  end

  local keyBase = string.sub(failedKey, 1, #failedKey - #failedId)
  local holder = redis.call('GET', lineageKey)

  local function removeCanonicalAdmissionIndexes(proposalKey, proposalId)
    local actionIndexKey = redis.call('HGET', proposalKey, 'canonicalAdmissionActionIndexKey')
    local subjectIndexKey = redis.call('HGET', proposalKey, 'canonicalAdmissionSubjectIndexKey')
    if actionIndexKey then redis.call('ZREM', actionIndexKey, proposalId) end
    if subjectIndexKey then redis.call('ZREM', subjectIndexKey, proposalId) end
  end

  local function restoreCanonicalAdmissionIndexes(proposalKey, proposalId, createdAt)
    local actionIndexKey = redis.call('HGET', proposalKey, 'canonicalAdmissionActionIndexKey')
    local subjectIndexKey = redis.call('HGET', proposalKey, 'canonicalAdmissionSubjectIndexKey')
    if actionIndexKey then redis.call('ZADD', actionIndexKey, tonumber(createdAt), proposalId) end
    if subjectIndexKey then redis.call('ZADD', subjectIndexKey, tonumber(createdAt), proposalId) end
  end

  -- A staged holder cannot be superseded by create(). If lineage moved anyway,
  -- keep the record for diagnosis rather than running a second recovery model.
  if holder and holder ~= failedId then return 0 end

  local settledType = redis.call('TYPE', settledKey).ok
  if settledType ~= 'none' and settledType ~= 'zset' then return redis.error_reply('history index type conflict') end
  local restoredId = nil
  local restoredAt = nil
  local fromCreate = false
  local candidates = {}
  local function consider(predecessorId, creationCustody)
    local predecessorKey = keyBase .. predecessorId
    if redis.call('HGET', predecessorKey, 'status') == 'superseded'
      and redis.call('HGET', predecessorKey, 'supersededBy') == failedId
      and redis.call('HGET', predecessorKey, 'ownerUserId') == redis.call('HGET', failedKey, 'ownerUserId') then
      local createdAt = tonumber(redis.call('HGET', predecessorKey, 'createdAt'))
      candidates[predecessorId] = createdAt
      if not restoredId or (not fromCreate and (creationCustody or createdAt > restoredAt)) then
        restoredId = predecessorId
        restoredAt = createdAt
        fromCreate = creationCustody
      end
    end
  end
  for _, predecessorId in ipairs(predecessors) do consider(predecessorId, true) end
  for _, predecessorId in ipairs(deliveryPredecessors) do consider(predecessorId, false) end
  removeCanonicalAdmissionIndexes(failedKey, failedId)
  redis.call('DEL', failedKey)
  redis.call('ZREM', pendingKey, failedId)
  redis.call('ZREM', settledKey, failedId)
  for i = negativeAuthorizationKeyStart, #KEYS do
    redis.call('ZREM', KEYS[i], failedId)
  end
  if conditionalDeleteKey and redis.call('GET', conditionalDeleteKey) == failedId then
    redis.call('DEL', conditionalDeleteKey)
  end

  if holder then
    redis.call('DEL', lineageKey)
  end

  if restoredId then
    for predecessorId, _ in pairs(candidates) do
      if predecessorId ~= restoredId then
        redis.call('HSET', keyBase .. predecessorId, 'supersededBy', restoredId)
      end
    end
    local predecessorKey = keyBase .. restoredId
    redis.call('HSET', predecessorKey, 'status', 'pending')
    redis.call('HDEL', predecessorKey, 'supersededBy', 'supersededAt')
    redis.call('ZREM', settledKey, restoredId)
    redis.call('ZADD', pendingKey, restoredAt, restoredId)
    redis.call('SET', lineageKey, restoredId)
    restoreCanonicalAdmissionIndexes(predecessorKey, restoredId, restoredAt)
  end

  return 1
`;

export async function abortRedisDispatchStaged(
  redis: RedisClient,
  params: {
    detailKey: string;
    pendingKey: string;
    settledKey: string;
    lineageKey: string;
    proposalId: string;
    conditionalDeleteKey?: string;
    negativeAuthorizationKeys: string[];
  },
): Promise<void> {
  const keys = params.conditionalDeleteKey
    ? [
        params.detailKey,
        params.pendingKey,
        params.lineageKey,
        params.settledKey,
        params.conditionalDeleteKey,
        ...params.negativeAuthorizationKeys,
      ]
    : [params.detailKey, params.pendingKey, params.lineageKey, params.settledKey, ...params.negativeAuthorizationKeys];
  await redis.eval(
    ABORT_STAGED_DISPATCH_LUA,
    keys.length,
    ...keys,
    params.proposalId,
    params.conditionalDeleteKey ? '1' : '0',
  );
}
