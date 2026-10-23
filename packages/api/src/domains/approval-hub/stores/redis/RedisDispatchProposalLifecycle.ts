/** CAS transition: pending → approved. */
export const CAS_APPROVE_DISPATCH_PROPOSAL_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'pending' then return 0 end
  redis.call('HSET', key, 'status', 'approved',
    'decidedAt', ARGV[1],
    'decidedBy', ARGV[2],
    'approvalOwnerAuthProvenance', ARGV[4])
  redis.call('ZREM', pendingKey, ARGV[3])
  redis.call('ZADD', settledKey, ARGV[1], ARGV[3])
  for i = 4, #KEYS do
    redis.call('ZREM', KEYS[i], ARGV[3])
  end
  return 1
`;

/**
 * CAS rollback: approved → pending, with the existing lineage supersession
 * guard. Canonical derived index keys occupy the tail of KEYS so superseded
 * records keep their legacy denial projections but leave canonical admission.
 */
export const CAS_REVERT_DISPATCH_PROPOSAL_PENDING_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local lineageKey = KEYS[4]
  local canonicalIndexCount = tonumber(ARGV[3])
  local canonicalIndexKeyStart = #KEYS - canonicalIndexCount + 1
  local function removeCanonicalAdmissionIndexes()
    local actionIndexKey = redis.call('HGET', key, 'canonicalAdmissionActionIndexKey')
    local subjectIndexKey = redis.call('HGET', key, 'canonicalAdmissionSubjectIndexKey')
    if actionIndexKey then redis.call('ZREM', actionIndexKey, ARGV[2]) end
    if subjectIndexKey then redis.call('ZREM', subjectIndexKey, ARGV[2]) end
  end
  local status = redis.call('HGET', key, 'status')
  if status ~= 'approved' then return 0 end
  local settledType = redis.call('TYPE', settledKey).ok
  if settledType ~= 'none' and settledType ~= 'zset' then return redis.error_reply('history index type conflict') end

  local currentHolder = redis.call('GET', lineageKey)
  if currentHolder and currentHolder ~= ARGV[2] then
    local keyBase = string.sub(key, 1, #key - #ARGV[2])
    local holderKey = keyBase .. currentHolder
    local publicationRaw = redis.call('HGET', holderKey, 'publication')
    local rollbackPredecessors = nil
    if redis.call('HGET', holderKey, 'status') == 'pending' and publicationRaw then
      local publicationOk, publication = pcall(cjson.decode, publicationRaw)
      if not publicationOk then return redis.error_reply('invalid holder publication') end
      if publication.state == 'staged' then
        if redis.call('HGET', holderKey, 'ownerUserId') ~= redis.call('HGET', key, 'ownerUserId') then
          return redis.error_reply('rollback custody owner mismatch')
        end
        local prior = redis.call('HGET', holderKey, 'deliveryRollbackPredecessorIds')
        rollbackPredecessors = {}
        if prior then
          local priorOk, decoded = pcall(cjson.decode, prior)
          if not priorOk or type(decoded) ~= 'table' then return redis.error_reply('invalid rollback custody') end
          rollbackPredecessors = decoded
        end
        local found = false
        for _, id in ipairs(rollbackPredecessors) do if id == ARGV[2] then found = true end end
        if not found then rollbackPredecessors[#rollbackPredecessors + 1] = ARGV[2] end
      end
    end
    -- Dynamic custody is not the immutable create-time supersession receipt.
    if rollbackPredecessors then
      redis.call('HSET', holderKey, 'deliveryRollbackPredecessorIds', cjson.encode(rollbackPredecessors))
    end
    redis.call('HSET', key, 'status', 'superseded', 'supersededBy', currentHolder, 'supersededAt', ARGV[4])
    redis.call('HDEL', key, 'decidedAt', 'decidedBy', 'approvalOwnerAuthProvenance')
    redis.call('ZADD', settledKey, ARGV[4], ARGV[2])
    removeCanonicalAdmissionIndexes()
    for i = 5, canonicalIndexKeyStart - 1 do
      redis.call('ZADD', KEYS[i], tonumber(ARGV[1]), ARGV[2])
    end
    return 2
  end

  redis.call('HSET', key, 'status', 'pending')
  redis.call('HDEL', key, 'decidedAt', 'decidedBy', 'approvalOwnerAuthProvenance', 'supersededAt')
  if #ARGV > 4 then redis.call('HSET', key, unpack(ARGV, 5)) end
  redis.call('ZADD', pendingKey, ARGV[1], ARGV[2])
  redis.call('ZREM', settledKey, ARGV[2])
  redis.call('SET', lineageKey, ARGV[2])
  for i = 5, canonicalIndexKeyStart - 1 do
    redis.call('ZADD', KEYS[i], tonumber(ARGV[1]), ARGV[2])
  end
  for i = canonicalIndexKeyStart, #KEYS do
    redis.call('ZADD', KEYS[i], tonumber(ARGV[1]), ARGV[2])
  end
  return 1
`;

/** CAS transition: pending → rejected. */
export const CAS_REJECT_DISPATCH_PROPOSAL_LUA = `
  local key = KEYS[1]
  local pendingKey = KEYS[2]
  local settledKey = KEYS[3]
  local status = redis.call('HGET', key, 'status')
  if status ~= 'pending' then return 0 end
  redis.call('HSET', key, 'status', 'rejected',
    'decidedAt', ARGV[1],
    'decidedBy', ARGV[2])
  redis.call('ZREM', pendingKey, ARGV[3])
  redis.call('ZADD', settledKey, ARGV[1], ARGV[3])
  return 1
`;
