function encode(value: string): string {
  return encodeURIComponent(value);
}

export const DeferredPersonMemoryReceiptKeys = {
  receipt: (ownerUserId: string, receiptId: string) =>
    `person-memory:deferred-receipt:${encode(ownerUserId)}:${encode(receiptId)}`,
  owner: (receiptId: string) => `person-memory:deferred-receipt-owner:${encode(receiptId)}`,
  dedupe: (ownerUserId: string, dedupeHash: string) =>
    `person-memory:deferred-dedupe:${encode(ownerUserId)}:${dedupeHash}`,
  ready: (ownerUserId: string) => `person-memory:deferred-ready:${encode(ownerUserId)}`,
  proposal: (ownerUserId: string, proposalId: string) =>
    `person-memory:deferred-proposal:${encode(ownerUserId)}:${encode(proposalId)}`,
  binding: (ownerUserId: string, kind: 'registered_person' | 'registered_entity', ref: string) =>
    `person-memory:deferred-binding:${encode(ownerUserId)}:${kind}:${encode(ref)}`,
} as const;

const TYPE_GUARD_LUA = `
local function allowed_type(key, expected)
  local actual = redis.call('TYPE', key)['ok']
  return actual == 'none' or actual == expected
end
`;

export const DEFERRED_RECEIPT_STAGE_LUA = `
${TYPE_GUARD_LUA}
if not allowed_type(KEYS[1], 'string') or not allowed_type(KEYS[2], 'string')
  or not allowed_type(KEYS[3], 'string') or not allowed_type(KEYS[4], 'zset')
  or not allowed_type(KEYS[5], 'set') then return 'CONFLICT' end
if redis.call('EXISTS', KEYS[1]) == 1 then return 'EXISTS' end
local locatedOwner = redis.call('GET', KEYS[2])
if locatedOwner and locatedOwner ~= ARGV[2] then return 'CONFLICT' end
local duplicate = redis.call('GET', KEYS[3])
if duplicate then return 'DEDUPED:' .. duplicate end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3])
redis.call('SADD', KEYS[5], ARGV[6])
if ARGV[5] == '1' then redis.call('ZADD', KEYS[4], tonumber(ARGV[4]), ARGV[6]) end
return 'CREATED'
`;

export const DEFERRED_RECEIPT_CLAIM_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_AVAILABLE' end
local current = cjson.decode(raw)
if current.state == 'claimed' and tonumber(current.claimUntil or 0) > tonumber(ARGV[3]) then
  return 'CLAIMED_ELSEWHERE'
end
if current.state ~= 'deferred' and current.state ~= 'claimed' then return 'NOT_AVAILABLE' end
redis.call('SET', KEYS[1], ARGV[1])
return 'CLAIMED'
`;

export const DEFERRED_RECEIPT_RELEASE_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.state ~= 'claimed' or current.claimId ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`;

export const DEFERRED_RECEIPT_REARM_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.state ~= 'claimed' or current.claimId ~= ARGV[2]
  or tonumber(current.claimUntil or 0) <= tonumber(ARGV[3]) then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
return 1
`;

export const DEFERRED_RECEIPT_WITHDRAW_LUA = `
${TYPE_GUARD_LUA}
if not allowed_type(KEYS[1], 'string') or not allowed_type(KEYS[2], 'zset')
  or not allowed_type(KEYS[3], 'string')
  or (ARGV[3] == '1' and not allowed_type(KEYS[4], 'set')) then return 'CONFLICT' end
local raw = redis.call('GET', KEYS[1])
if not raw then return 'NOT_AVAILABLE' end
local current = cjson.decode(raw)
if current.state == 'withdrawn' then return 'REPLAYED' end
if current.state ~= 'awaiting_confirmation' and current.state ~= 'deferred' and current.state ~= 'claimed' then
  return 'CONFLICT'
end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[2])
if redis.call('GET', KEYS[3]) == ARGV[4] then redis.call('DEL', KEYS[3]) end
if ARGV[3] == '1' then redis.call('SREM', KEYS[4], ARGV[2]) end
return 'WITHDRAWN'
`;

export const DEFERRED_RECEIPT_FORGET_LUA = `
${TYPE_GUARD_LUA}
if not allowed_type(KEYS[1], 'string') or not allowed_type(KEYS[2], 'string')
  or not allowed_type(KEYS[3], 'zset') or not allowed_type(KEYS[4], 'string')
  or (ARGV[3] == '1' and not allowed_type(KEYS[5], 'string'))
  or (ARGV[2] == '1' and not allowed_type(KEYS[6], 'set')) then return 'CONFLICT' end
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local current = cjson.decode(raw)
if current.state == 'proposed' then return 'PROPOSAL_BOUND:' .. current.proposalId end
redis.call('DEL', KEYS[1], KEYS[2])
redis.call('ZREM', KEYS[3], ARGV[1])
if redis.call('GET', KEYS[4]) == ARGV[4] then redis.call('DEL', KEYS[4]) end
if ARGV[3] == '1' and redis.call('GET', KEYS[5]) == ARGV[1] then redis.call('DEL', KEYS[5]) end
if ARGV[2] == '1' then redis.call('SREM', KEYS[6], ARGV[1]) end
return 1
`;
