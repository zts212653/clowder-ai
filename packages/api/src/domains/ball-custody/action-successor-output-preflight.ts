import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ActionSuccessorOutputPreflightResult } from './ActionSuccessorLeaseStore.js';
import { ActionSuccessorKeys } from './action-successor-keys.js';
import { PREFLIGHT_ACTION_SUCCESSOR_OUTPUT_LUA } from './action-successor-redis-scripts.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';

export async function preflightActionSuccessorOutputInRedis(
  redis: RedisClient,
  lease: ActionSuccessorLease,
  generation: number,
  catId: string,
  terminalPredicateDigest?: string,
): Promise<ActionSuccessorOutputPreflightResult | { ok: false; reason: 'lease_missing' }> {
  const reason = String(
    await redis.eval(
      PREFLIGHT_ACTION_SUCCESSOR_OUTPUT_LUA,
      2,
      ActionSuccessorKeys.detail(lease.leaseId),
      ActionSuccessorKeys.subjectTerminal(lease.subjectRef),
      String(generation),
      terminalPredicateDigest ?? '',
      catId,
    ),
  );
  if (reason === 'active' || reason === 'verified_success') return { ok: true, reason };
  if (
    reason === 'subject_terminal' ||
    reason === 'stale_generation' ||
    reason === 'lease_not_active' ||
    reason === 'predicate_mismatch' ||
    reason === 'holder_not_assigned' ||
    reason === 'holder_terminal' ||
    reason === 'lease_missing'
  ) {
    return { ok: false, reason };
  }
  throw new Error(`unexpected action successor output preflight result: ${reason}`);
}
