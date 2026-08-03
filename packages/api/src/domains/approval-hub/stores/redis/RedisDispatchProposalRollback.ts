import type { RedisClient } from '@cat-cafe/shared/utils';

const ABORT_STAGED_DISPATCH_LUA = `
  local failedKey = KEYS[1]
  local pendingKey = KEYS[2]
  local lineageKey = KEYS[3]
  local conditionalDeleteKey = KEYS[4]
  local failedId = ARGV[1]

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

  local keyBase = string.sub(failedKey, 1, #failedKey - #failedId)
  local holder = redis.call('GET', lineageKey)

  -- A staged holder cannot be superseded by create(). If lineage moved anyway,
  -- keep the record for diagnosis rather than running a second recovery model.
  if holder and holder ~= failedId then return 0 end

  redis.call('DEL', failedKey)
  redis.call('ZREM', pendingKey, failedId)
  if conditionalDeleteKey and redis.call('GET', conditionalDeleteKey) == failedId then
    redis.call('DEL', conditionalDeleteKey)
  end

  if holder then
    redis.call('DEL', lineageKey)
  end

  for i = 1, #predecessors do
    local predecessorId = predecessors[i]
    local predecessorKey = keyBase .. predecessorId
    if redis.call('HGET', predecessorKey, 'status') == 'superseded'
      and redis.call('HGET', predecessorKey, 'supersededBy') == failedId then
      local createdAt = redis.call('HGET', predecessorKey, 'createdAt')
      redis.call('HSET', predecessorKey, 'status', 'pending')
      redis.call('HDEL', predecessorKey, 'supersededBy')
      redis.call('ZADD', pendingKey, tonumber(createdAt), predecessorId)
      redis.call('SET', lineageKey, predecessorId)
      return 1
    end
  end

  return 1
`;

export async function abortRedisDispatchStaged(
  redis: RedisClient,
  params: {
    detailKey: string;
    pendingKey: string;
    lineageKey: string;
    proposalId: string;
    conditionalDeleteKey?: string;
  },
): Promise<void> {
  const keys = params.conditionalDeleteKey
    ? [params.detailKey, params.pendingKey, params.lineageKey, params.conditionalDeleteKey]
    : [params.detailKey, params.pendingKey, params.lineageKey];
  await redis.eval(ABORT_STAGED_DISPATCH_LUA, keys.length, ...keys, params.proposalId);
}
