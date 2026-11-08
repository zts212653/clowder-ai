import type { RedisClient } from '@cat-cafe/shared/utils';
import { ActionSuccessorKeys } from '../../../../ball-custody/action-successor-keys.js';
import {
  type ApprovedTaskContinuationInput,
  type ApprovedTaskContinuationResult,
  decideApprovedTaskContinuation,
  implementationUsedProposal,
} from '../../../../ball-custody/approved-task-continuation.js';
import {
  ApprovedTaskContinuationUnavailable,
  readContinuationValue,
} from '../../../../ball-custody/approved-task-continuation-diagnostics.js';
import {
  type ApprovedTaskImplementationHistory,
  parseApprovedTaskImplementationHistory,
} from '../../../../ball-custody/approved-task-implementation-history.js';
import { ProposalKeys } from '../redis-keys/proposals/proposal-keys.js';
import { TaskKeys } from '../redis-keys/task-keys.js';
import { ThreadKeys } from '../redis-keys/thread-keys.js';
import { hydrateProposal } from './RedisProposalStoreHelpers.js';
import { hydrateTask } from './RedisTaskCodec.js';
import { runWithExclusiveRedisWatchSession } from './RedisWatchSession.js';

async function readWatchedImplementationHistory(
  session: RedisClient,
  currentDetailKey: string | null,
  input: ApprovedTaskContinuationInput,
) {
  // Current identity is not history: completed/fresh-revision leases remain in the canonical ALL index.
  const prefix = session.options.keyPrefix ?? '';
  const indexed = await readContinuationValue('history_index', ActionSuccessorKeys.ALL, () =>
    session.smembers(ActionSuccessorKeys.ALL),
  );
  if (currentDetailKey) indexed.push(currentDetailKey);
  const detailKeys = [...new Set(indexed)].map((key) =>
    prefix && key.startsWith(prefix) ? key.slice(prefix.length) : key,
  );
  if (!detailKeys.length) return [];
  await session.watch(...detailKeys);
  const records = await readContinuationValue('implementation_history', ActionSuccessorKeys.ALL, () =>
    session.mget(...detailKeys),
  );
  const target = { tenantScope: input.actor.userId, subjectRef: `subject:task:${input.taskId}` };
  const leases = records.map((raw, index) => parseApprovedTaskImplementationHistory(raw, target, detailKeys[index]));
  // Only a decoded, unrelated identity is skipped, including original bytes retained by recovery.
  return leases.filter((lease): lease is ApprovedTaskImplementationHistory => lease !== null);
}

/** WATCH covers every authority input. A losing CAS never adds a receipt or dispatches work. */
export async function continueRedisApprovedTask(
  redis: RedisClient,
  input: ApprovedTaskContinuationInput,
): Promise<ApprovedTaskContinuationResult> {
  const proposalKey = ProposalKeys.detail(input.proposalId);
  return runWithExclusiveRedisWatchSession<ApprovedTaskContinuationResult>(redis, proposalKey, async (session) => {
    const taskKey = TaskKeys.detail(input.taskId);
    const identityKey = ActionSuccessorKeys.identity({
      tenantScope: input.actor.userId,
      subjectRef: `subject:task:${input.taskId}`,
      actionFamily: 'implement',
      successorSlot: 'implementer',
    });
    await session.watch(taskKey, identityKey, ActionSuccessorKeys.ALL);
    const rawProposal = await readContinuationValue('proposal', proposalKey, () => session.hgetall(proposalKey));
    if (!rawProposal.proposalId || !rawProposal.createdThreadId)
      throw new ApprovedTaskContinuationUnavailable('missing', 'proposal', proposalKey);
    const childKey = ThreadKeys.detail(rawProposal.createdThreadId);
    await session.watch(childKey);
    const [rawTask, rawChild, leaseDetailKey] = await Promise.all([
      readContinuationValue('task', taskKey, () => session.hgetall(taskKey)),
      readContinuationValue('child', childKey, () => session.hgetall(childKey)),
      readContinuationValue('implementation_history', identityKey, () => session.get(identityKey)),
    ]);
    if (!rawTask.id) throw new ApprovedTaskContinuationUnavailable('missing', 'task', taskKey);
    if (!rawChild.id) throw new ApprovedTaskContinuationUnavailable('missing', 'child', childKey);
    const implementations = await readWatchedImplementationHistory(session, leaseDetailKey, input);
    const proposal = hydrateProposal(rawProposal);
    const priorImplementation = implementations.find((lease) => implementationUsedProposal(lease, proposal)) ?? null;
    const decision = decideApprovedTaskContinuation(
      input,
      proposal,
      hydrateTask(rawTask),
      {
        id: rawChild.id,
        createdBy: rawChild.createdBy ?? '',
        parentThreadId: rawChild.parentThreadId,
        createdFromProposalId: rawChild.createdFromProposalId,
        projectPath: rawChild.projectPath ?? '',
        deletedAt: rawChild.deletedAt && rawChild.deletedAt !== '0' ? Number(rawChild.deletedAt) : null,
      },
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
  }).catch((error: unknown): ApprovedTaskContinuationResult => {
    if (!(error instanceof ApprovedTaskContinuationUnavailable)) throw error;
    return { outcome: 'rejected', reason: 'unavailable', diagnostic: error.diagnostic };
  });
}
