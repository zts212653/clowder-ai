/**
 * Lua scripts for RedisProfileUpdateProposalStore (F246 Phase H).
 *
 * Extracted here to keep RedisProfileUpdateProposalStore.ts within the 350-line SOP limit.
 * All scripts are atomic (Redis executes Lua single-threaded), eliminating crash windows
 * between hash update and settled index update.
 */

/**
 * CAS + settle index update for finalizeApproval (approving → approved).
 *
 * Why atomic: A two-step approach (cas → ZADD settled) leaves a crash window where the
 * hash reaches 'approved' status but the settled ZSet is never updated, making the proposal
 * invisible to listSettledByUser() until a manual backfill. One Lua script eliminates that.
 *
 * KEYS[1] = detail hash key (profile-update:{id})
 * KEYS[2] = settled ZSet key (profile-update:settled:{userId})
 * ARGV[1] = expected status ("approving")
 * ARGV[2] = proposalId (ZSet member)
 * ARGV[3] = approvedAt as string (score for ZADD, also written to hash)
 * Returns 1 on success, 0 on CAS miss or missing hash.
 */
export const CAS_FINALIZE_AND_SETTLE_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return 0 end
if current ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', 'approved', 'approvedAt', ARGV[3], 'claimedAt', '0')
redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[2])
return 1
`;

/**
 * CAS + settle index update for markRejected (pending → rejected).
 *
 * KEYS[1] = detail hash key (profile-update:{id})
 * KEYS[2] = pending ZSet key (profile-update:pending:{userId})
 * KEYS[3] = settled ZSet key (profile-update:settled:{userId})
 * ARGV[1] = expected status ("pending")
 * ARGV[2] = proposalId (ZSet member)
 * ARGV[3] = rejectedAt as string (score for ZADD)
 * ARGV[4] = rejectedBy
 * ARGV[5] = rejectionReason (may be empty string)
 * Returns 1 on success, 0 on CAS miss or missing hash.
 */
export const CAS_REJECT_AND_SETTLE_LUA = `
local current = redis.call('HGET', KEYS[1], 'status')
if not current then return 0 end
if current ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'status', 'rejected', 'rejectedAt', ARGV[3], 'rejectedBy', ARGV[4])
if ARGV[5] ~= '' then
  redis.call('HSET', KEYS[1], 'rejectionReason', ARGV[5])
end
redis.call('ZREM', KEYS[2], ARGV[2])
redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[2])
return 1
`;
