import type { RedisClient } from '@cat-cafe/shared/utils';
import type { ActionSuccessorOutputPreflightResult } from './ActionSuccessorLeaseStore.js';
import { ActionSuccessorKeys } from './action-successor-keys.js';
import { PREFLIGHT_ACTION_SUCCESSOR_OUTPUT_LUA } from './action-successor-redis-scripts.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import { runTaskContinuationFencedCommand } from './approved-task-continuation-fence.js';

export async function preflightActionSuccessorOutputInRedis(
  redis: RedisClient,
  lease: ActionSuccessorLease,
  generation: number,
  catId: string,
  terminalPredicateDigest?: string,
): Promise<ActionSuccessorOutputPreflightResult | { ok: false; reason: 'lease_missing' }> {
  const fenced = await runTaskContinuationFencedCommand(redis, lease, {
    script: PREFLIGHT_ACTION_SUCCESSOR_OUTPUT_LUA,
    keys: [ActionSuccessorKeys.detail(lease.leaseId), ActionSuccessorKeys.subjectTerminal(lease.subjectRef)],
    args: [String(generation), terminalPredicateDigest ?? '', catId],
    allowCompletedTask: true,
  });
  if (!fenced.ok) return { ok: false, reason: 'predicate_mismatch' };
  const reason = String(fenced.result);
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
