export const CLAIM_ACTION_SUCCESSOR_LUA = `
local terminal = redis.call('GET', KEYS[3])
if terminal then return {'subject_terminal', terminal} end
local detailKey = redis.call('GET', KEYS[2])
if detailKey then
  local raw = redis.call('GET', detailKey)
  if raw then
    local current = cjson.decode(raw)
    if current.dispatchId == ARGV[1] then return {'replayed', raw} end
    return {'safe_wait', raw}
  end
  redis.call('DEL', KEYS[2])
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], KEYS[1])
redis.call('SADD', KEYS[4], KEYS[1])
return {'claimed', ARGV[2]}
`;

export const CAS_ACTION_SUCCESSOR_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if tonumber(current.revision) ~= tonumber(ARGV[1]) then return -1 end
if redis.call('GET', KEYS[2]) ~= KEYS[1] then return -2 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

export const COMMIT_ACTION_SUCCESSOR_CAS_LUA = `
if redis.call('EXISTS', KEYS[3]) == 1 then return -3 end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if tonumber(current.revision) ~= tonumber(ARGV[1]) then return -1 end
if redis.call('GET', KEYS[2]) ~= KEYS[1] then return -2 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;

export const MARK_ACTION_SUBJECT_TERMINAL_LUA = `
local existing = redis.call('GET', KEYS[1])
if existing then
  local current = cjson.decode(existing)
  local candidate = cjson.decode(ARGV[1])
  if tonumber(current.observedAt) >= tonumber(candidate.observedAt) then return existing end
  redis.call('SADD', KEYS[2], existing)
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[1])
return ARGV[1]
`;

export const CLEAR_ACTION_SUBJECT_TERMINAL_LUA = `
local existing = redis.call('GET', KEYS[1])
if not existing then return 0 end
local current = cjson.decode(existing)
if tonumber(current.observedAt) >= tonumber(ARGV[1]) then return 0 end
redis.call('SADD', KEYS[2], existing)
redis.call('SADD', KEYS[2], ARGV[2])
redis.call('DEL', KEYS[1])
return 1
`;

export const PREFLIGHT_ACTION_SUCCESSOR_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 'subject_terminal' end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'lease_missing' end
local current = cjson.decode(raw)
if tonumber(current.generation) ~= tonumber(ARGV[1]) then return 'stale_generation' end
if ARGV[2] ~= '' then
  if not current.terminalPredicate or current.terminalPredicate.digest ~= ARGV[2] then return 'predicate_mismatch' end
end
if current.status ~= 'active' then return 'lease_not_active' end
return 'active'
`;

export const PREFLIGHT_ACTION_SUCCESSOR_OUTPUT_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 'subject_terminal' end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'lease_missing' end
local current = cjson.decode(raw)
if tonumber(current.generation) ~= tonumber(ARGV[1]) then return 'stale_generation' end
if ARGV[2] ~= '' then
  if not current.terminalPredicate or current.terminalPredicate.digest ~= ARGV[2] then return 'predicate_mismatch' end
end
local holderAssigned = false
for _, holderCatId in ipairs(current.holderCatIds or {}) do
  if holderCatId == ARGV[3] then holderAssigned = true break end
end
if not holderAssigned then return 'holder_not_assigned' end
local holderOutcome = current.holderOutcomes and current.holderOutcomes[ARGV[3]]
if holderOutcome then
  if holderOutcome.outcome == 'succeeded' then return 'verified_success' end
  return 'holder_terminal'
end
if current.status ~= 'active' then return 'lease_not_active' end
return 'active'
`;
