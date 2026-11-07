import { randomUUID } from 'node:crypto';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { canonicalizeActionTerminalPredicate } from '../../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { ActionSuccessorKeys } from '../../dist/domains/ball-custody/action-successor-keys.js';
import { claimActionSuccessor } from '../../dist/domains/ball-custody/action-successor-state-machine.js';
import { RedisActionSuccessorLeaseStore } from '../../dist/domains/ball-custody/RedisActionSuccessorLeaseStore.js';
import { assertRedisIsolationOrThrow } from './redis-test-helpers.js';

export function actionRecoveryLease(n, historical) {
  const subjectRef = `subject:task:history-${n}`;
  const { lease } = claimActionSuccessor(null, {
    leaseId: `lease-${n}`,
    tenantScope: 'test-owner',
    subjectRef,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['codex61-sol'],
    dispatchId: `dispatch-${n}`,
    claimOrigin: 'structured_transfer',
    holderThreadId: 'test-thread',
    predecessorCatId: 'codex-astra',
    predecessorThreadId: 'test-origin',
    issuerStandingEvidenceRef: 'message:test-request',
    evidenceRefs: ['message:test-request'],
    now: 1,
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: 'implement',
      subjectRef,
      predicate: { kind: 'task_done' },
    }),
  });
  return {
    ...lease,
    status: historical ? 'completed' : 'active',
    dispatchDeliveryState: historical ? 'delivered' : 'pending',
  };
}

export async function withActionRecoveryRedis(body) {
  assertRedisIsolationOrThrow(process.env.REDIS_URL, '1843 ActionSuccessor recovery');
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `b3-${randomUUID()}:` });
  const store = new RedisActionSuccessorLeaseStore(redis);
  async function seed(value) {
    const key = ActionSuccessorKeys.detail(value.leaseId);
    await redis.set(key, JSON.stringify(value));
    await redis.set(ActionSuccessorKeys.identity(value), `${redis.options.keyPrefix}${key}`);
    await redis.sadd(ActionSuccessorKeys.ALL, `${redis.options.keyPrefix}${key}`);
  }
  try {
    await body({ redis, store, seed });
  } finally {
    await redis.quit();
  }
}
