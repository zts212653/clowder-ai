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

  local currentHolder = redis.call('GET', lineageKey)
  if currentHolder and currentHolder ~= ARGV[2] then
    redis.call('HSET', key, 'status', 'superseded', 'supersededBy', currentHolder)
    redis.call('HDEL', key, 'decidedAt', 'decidedBy', 'approvalOwnerAuthProvenance')
    redis.call('ZREM', settledKey, ARGV[2])
    removeCanonicalAdmissionIndexes()
    for i = 5, canonicalIndexKeyStart - 1 do
      redis.call('ZADD', KEYS[i], tonumber(ARGV[1]), ARGV[2])
    end
    return 2
  end

  redis.call('HSET', key, 'status', 'pending')
  redis.call('HDEL', key, 'decidedAt', 'decidedBy', 'approvalOwnerAuthProvenance')
  if #ARGV > 3 then redis.call('HSET', key, unpack(ARGV, 4)) end
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
