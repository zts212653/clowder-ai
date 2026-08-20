import { MAX_WRITE_OPPORTUNITY_GENERATION } from '@cat-cafe/shared';

function encode(value: string): string {
  return encodeURIComponent(value);
}

/**
 * One hash per (owner, dedupeLineage). Fields:
 *   `g:<generation>` -> terminal outcome for that exact generation
 *   `invalidated`    -> first invalidation reason for the whole lineage (absorbing)
 *
 * No TTL: a terminal disposition and an invalidation are owner-visible lineage truth and must
 * survive restart (persistence iron rule / LL-048). Only `claimUntil`-style leases are time-bounded
 * in this domain, and this ledger holds no lease.
 */
export const WriteOpportunityTerminalKeys = {
  lineage: (ownerUserId: string, dedupeLineage: string) =>
    `person-memory:write-opportunity-terminal:${encode(ownerUserId)}:${encode(dedupeLineage)}`,
} as const;

export const WRITE_OPPORTUNITY_INVALIDATED_FIELD = 'invalidated';

export function writeOpportunityGenerationField(generation: number): string {
  if (!Number.isInteger(generation) || generation <= 0 || generation > MAX_WRITE_OPPORTUNITY_GENERATION) {
    throw new RangeError('generation must be a positive uint32');
  }
  return `g:${generation}`;
}

export function parseWriteOpportunityGenerationField(field: string): number | null {
  if (!field.startsWith('g:')) return null;
  const parsed = Number(field.slice(2));
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_WRITE_OPPORTUNITY_GENERATION ? parsed : null;
}

/**
 * Record a terminal generation.
 *
 * Guards, in order:
 *  - the key must be a hash or absent (no cross-type clobber, mirroring the deferred-receipt guard)
 *  - an existing conflicting outcome for the same generation is refused rather than overwritten,
 *    because two different dispositions for one generation means an upstream mutual-exclusion bug
 *    (F276 AC-A19) and silently keeping the last writer would hide it
 *  - an identical replay is accepted as a no-op so at-least-once callbacks stay safe
 */
export const RECORD_WRITE_OPPORTUNITY_TERMINAL_LUA = `
local actual = redis.call('TYPE', KEYS[1])['ok']
if actual ~= 'none' and actual ~= 'hash' then return 'CONFLICT' end
local existing = redis.call('HGET', KEYS[1], ARGV[1])
if existing then
  if existing ~= ARGV[2] then return 'OUTCOME_CONFLICT:' .. existing end
  return 'REPLAYED'
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2], ARGV[1] .. ':at', ARGV[3])
redis.call('PERSIST', KEYS[1])
return 'OK'
`;

/**
 * Record a lineage-level invalidation. The first reason wins: an invalidated lineage is absorbing,
 * so a later cause must not overwrite the original one (SR:129 — an invalidated generation must
 * never be re-sent, and the audit trail should name why it died first).
 */
export const INVALIDATE_WRITE_OPPORTUNITY_LINEAGE_LUA = `
local actual = redis.call('TYPE', KEYS[1])['ok']
if actual ~= 'none' and actual ~= 'hash' then return 'CONFLICT' end
if redis.call('HGET', KEYS[1], ARGV[1]) then return 'REPLAYED' end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2], ARGV[1] .. ':at', ARGV[3])
redis.call('PERSIST', KEYS[1])
return 'OK'
`;
