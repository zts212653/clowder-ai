/**
 * Lua scripts for RedisSessionHandoffProposalStore.
 *
 * Extracted from the main store file to keep it within the 350-line SOP limit.
 * All scripts are atomic Redis operations (Lua is single-threaded in Redis).
 */

/**
 * Compare-and-delete: DEL the dedup key only if it still points at the expected proposalId, so a
 * release never wipes a sibling's reservation that already replaced the key.
 * KEYS[1] = dedup key; ARGV[1] = expectedProposalId.
 */
export const RELEASE_DEDUP_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * CAS Lua: atomically check current status ∈ expected (comma-separated) → HSET field/value pairs.
 * KEYS[1] = detail hash; ARGV[1] = expected statuses ("pending" | "pending,approving");
 * ARGV[2..] = HSET pairs (caller includes new status + updatedAt).
 * Returns 1 on match, 0 otherwise (incl. missing key — HGET returns false).
 */
export const CAS_STATUS_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return 0 end
local matched = false
for st in string.gmatch(ARGV[1], '[^,]+') do
  if st == current then matched = true end
end
if not matched then return 0 end
local fields = {}
for i = 2, #ARGV do fields[#fields + 1] = ARGV[i] end
if #fields > 0 then redis.call('HSET', KEYS[1], unpack(fields)) end
return 1
`;

/**
 * CAS + settle index update — atomic in a single Lua script (F246 Phase G P1 fix).
 *
 * Why: A two-step approach (cas() → pipeline ZADD) leaves a crash window where the hash
 * reaches terminal status (approved/rejected) but the settled sorted set is never updated.
 * The proposal becomes invisible to listSettledByUser() with no way to recover without
 * a manual backfill. Running everything in one Lua script eliminates that window because
 * Redis guarantees Lua execution is atomic.
 *
 * KEYS[1] = detail hash key (handoff-proposal:{id})
 * KEYS[2] = user pending ZSet key (handoff-proposals:user:{userId})
 * KEYS[3] = settled ZSet key (handoff-proposals:settled:{userId})
 * ARGV[1] = expected status (single value — "approving" or "pending")
 * ARGV[2] = new status ("approved" or "rejected")
 * ARGV[3] = updatedAt as string (used as ZADD score and HSET value)
 * ARGV[4] = proposalId (ZSet member for ZREM/ZADD)
 * Returns 1 on success, 0 on CAS miss or missing hash.
 */
export const CAS_AND_SETTLE_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return 0 end
if current ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', ARGV[2], 'updatedAt', ARGV[3])
redis.call('ZREM', KEYS[2], ARGV[4])
redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[4])
return 1
`;
