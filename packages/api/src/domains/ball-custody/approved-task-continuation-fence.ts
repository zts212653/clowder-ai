import type { TaskItem } from '@cat-cafe/shared';
import type { RedisClient } from '@cat-cafe/shared/utils';
import { hydrateProposal } from '../cats/services/stores/redis/RedisProposalStoreHelpers.js';
import { hydrateTask } from '../cats/services/stores/redis/RedisTaskCodec.js';
import { runWithExclusiveRedisWatchSession } from '../cats/services/stores/redis/RedisWatchSession.js';
import { ProposalKeys } from '../cats/services/stores/redis-keys/proposals/proposal-keys.js';
import { TaskKeys } from '../cats/services/stores/redis-keys/task-keys.js';
import { ThreadKeys } from '../cats/services/stores/redis-keys/thread-keys.js';
import type { ActionSuccessorLease } from './action-successor-state-machine.js';
import { approvedGenericTaskContinuation } from './approved-generic-task-proposal.js';
import { matchesContinuationChild } from './approved-task-continuation.js';
import { continuationEvidenceRef } from './approved-task-contract.js';

interface FencedCommand {
  script: string;
  keys: string[];
  args: string[];
  allowCompletedTask?: boolean;
}

async function matchesCurrentContinuation(
  session: RedisClient,
  lease: ActionSuccessorLease,
  task: TaskItem,
  ref: string,
): Promise<boolean> {
  const proposalId = /^proposal:([^:]+):continuation:/.exec(ref)?.[1];
  if (!proposalId) return false;
  const proposalKey = ProposalKeys.detail(proposalId);
  const childKey = ThreadKeys.detail(lease.holderThreadId);
  await session.watch(proposalKey, childKey);
  const [rawProposal, child] = await Promise.all([session.hgetall(proposalKey), session.hgetall(childKey)]);
  if (!rawProposal.proposalId || !child.id) return false;
  const proposal = hydrateProposal(rawProposal);
  const receipt = approvedGenericTaskContinuation(proposal, {
    ...task,
    developmentScope: task.entrustedWork?.developmentScope,
  });
  if (
    !receipt ||
    !matchesContinuationChild(proposal, {
      id: child.id,
      createdBy: child.createdBy ?? '',
      parentThreadId: child.parentThreadId,
      createdFromProposalId: child.createdFromProposalId,
      projectPath: child.projectPath ?? '',
      deletedAt: child.deletedAt && child.deletedAt !== '0' ? Number(child.deletedAt) : null,
    })
  )
    return false;
  const [catId] = lease.holderCatIds;
  return (
    lease.holderCatIds.length === 1 &&
    Boolean(
      catId &&
        receipt.targetCatIds.includes(catId) &&
        ref === `${continuationEvidenceRef(receipt)}:thread:${child.id}:cat:${catId}`,
    )
  );
}

async function hasCurrentContinuationAuthority(
  session: RedisClient,
  lease: ActionSuccessorLease,
  task: TaskItem,
  references: readonly string[],
): Promise<boolean> {
  // A returned lease may be back with the canonical owner; historical receipts do not replace that authority.
  if (
    lease.holderThreadId === task.threadId &&
    lease.holderCatIds.length === 1 &&
    lease.holderCatIds[0] === task.ownerCatId
  )
    return true;
  for (const ref of references) if (await matchesCurrentContinuation(session, lease, task, ref)) return true;
  return false;
}

/** The original lease scripts and the current generic authority commit at the same Redis boundary. */
export async function runTaskContinuationFencedCommand(
  redis: RedisClient,
  lease: ActionSuccessorLease,
  command: FencedCommand,
): Promise<{ ok: true; result: unknown } | { ok: false }> {
  const references = lease.evidenceRefs.filter((ref) => ref.startsWith('proposal:') && ref.includes(':continuation:'));
  if (references.length === 0) {
    return {
      ok: true,
      result: await redis.eval(command.script, command.keys.length, ...command.keys, ...command.args),
    };
  }
  if (lease.actionFamily !== 'implement' || !lease.subjectRef.startsWith('subject:task:')) return { ok: false };
  const taskKey = TaskKeys.detail(lease.subjectRef.slice('subject:task:'.length));
  return runWithExclusiveRedisWatchSession(redis, taskKey, async (session) => {
    await session.watch(...command.keys);
    const rawTask = await session.hgetall(taskKey);
    if (!rawTask.id) return { ok: false };
    const task = hydrateTask(rawTask);
    if (task.userId !== lease.tenantScope || (!command.allowCompletedTask && task.status === 'done'))
      return { ok: false };
    if (!(await hasCurrentContinuationAuthority(session, lease, task, references))) return { ok: false };
    const results = await session
      .multi()
      .eval(command.script, command.keys.length, ...command.keys, ...command.args)
      .exec();
    if (!results) return { ok: false };
    const result = results[0];
    if (!result) throw new Error('Continuation-fenced command returned no result');
    if (result[0]) throw result[0];
    return { ok: true, result: result[1] };
  });
}
