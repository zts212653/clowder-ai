import type { RedisClient } from '@cat-cafe/shared/utils';
import { ActionSuccessorKeys } from '../../../../ball-custody/action-successor-keys.js';
import { parseActionSuccessorLease } from '../../../../ball-custody/action-successor-redis-codecs.js';
import {
  type ApprovedTaskContinuationInput,
  type ApprovedTaskContinuationResult,
  decideApprovedTaskContinuation,
  implementationUsedProposal,
} from '../../../../ball-custody/approved-task-continuation.js';
import { ProposalKeys } from '../redis-keys/proposals/proposal-keys.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { ThreadKeys } from '../redis-keys/thread-keys.js';
import { hydrateProposal } from './RedisProposalStoreHelpers.js';
import { hydrateTask } from './RedisTaskCodec.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

async function readWatchedImplementationHistory(session: RedisClient, currentDetailKey: string | null) {
  // Current identity is not history: completed/fresh-revision leases remain in the canonical ALL index.
  const prefix = session.options.keyPrefix ?? '';
  const indexed = await session.smembers(ActionSuccessorKeys.ALL);
  if (currentDetailKey) indexed.push(currentDetailKey);
  const detailKeys = [...new Set(indexed)].map((key) =>
    prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key,
  );
  if (!detailKeys.length) return [];
  await session.watch(...detailKeys);
  const records = await session.mget(...detailKeys);
  try {
    const leases = records.map(parseActionSuccessorLease);
    // An indexed but unreadable payload is missing history, never proof that implementation did not occur.
    return leases.every((lease) => lease !== null) ? leases : null;
  } catch {
    return null;
  }
}

/** WATCH covers every authority input. A losing CAS never adds a receipt or dispatches work. */
export async function continueRedisApprovedTask(
  redis: RedisClient,
  input: ApprovedTaskContinuationInput,
): Promise<ApprovedTaskContinuationResult> {
  const proposalKey = ProposalKeys.detail(input.proposalId);
  return runWithExclusiveRedisWatchSession(redis, proposalKey, async (session) => {
    const taskKey = TaskKeys.detail(input.taskId);
    const identityKey = ActionSuccessorKeys.identity({
      tenantScope: input.actor.userId,
      subjectRef: `subject:task:${input.taskId}`,
      actionFamily: 'implement',
      successorSlot: 'implementer',
    });
    await session.watch(taskKey, identityKey, ActionSuccessorKeys.ALL);
    const rawProposal = await session.hgetall(proposalKey);
    if (!rawProposal.proposalId || !rawProposal.createdThreadId) return { outcome: 'rejected', reason: 'unavailable' };
    const childKey = ThreadKeys.detail(rawProposal.createdThreadId);
    await session.watch(childKey);
    const [rawTask, rawChild, leaseDetailKey] = await Promise.all([
      session.hgetall(taskKey),
      session.hgetall(childKey),
      session.get(identityKey),
    ]);
    const implementations = await readWatchedImplementationHistory(session, leaseDetailKey);
    if (!implementations) return { outcome: 'rejected', reason: 'unavailable' };
    const proposal = hydrateProposal(rawProposal);
    const priorImplementation = implementations.find((lease) => implementationUsedProposal(lease, proposal)) ?? null;
    const decision = decideApprovedTaskContinuation(
      input,
      proposal,
      rawTask.id ? hydrateTask(rawTask) : null,
      rawChild.id
        ? {
            id: rawChild.id,
            createdBy: rawChild.createdBy ?? '',
            parentThreadId: rawChild.parentThreadId,
            createdFromProposalId: rawChild.createdFromProposalId,
            projectPath: rawChild.projectPath ?? '',
            deletedAt: rawChild.deletedAt && rawChild.deletedAt !== '0' ? Number(rawChild.deletedAt) : null,
          }
        : null,
      priorImplementation,
    );
    if (decision.outcome === 'rejected') return decision;
    // Replays also validate WATCH: an owner/scope change during this request cannot yield stale success.
    const transaction = session.multi();
    if (decision.outcome === 'continued') {
      transaction.hset(proposalKey, 'taskContractContinuation', JSON.stringify(decision.receipt));
      transaction.persist(proposalKey);
    } else transaction.exists(proposalKey);
    const committed = await transaction.exec();
    if (!committed) return { outcome: 'rejected', reason: 'concurrent_change' };
    const error = committed.find(([err]) => err)?.[0];
    if (error) throw error;
    return decision;
  });
}
