import type { FreshnessSupplementAggregate, FreshnessSupplementProjection } from '@cat-cafe/shared';
import type { EnqueueResult } from '../../agents/invocation/InvocationQueue.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { FreshnessClosureStore } from '../FreshnessClosureStore.js';
import { projectFreshnessSupplement } from './FreshnessOutputCommitCoordinator.js';

interface StartupRecoveryLogger {
  info(fields: unknown, message?: string): void;
  warn(fields: unknown, message?: string): void;
  error(fields: unknown, message?: string): void;
}

interface SupplementQueueCarrier {
  threadId: string;
  userId: string;
  content: string;
  source: 'agent';
  sourceCategory: 'freshness';
  targetCats: string[];
  callerCatId: string;
  autoExecute: true;
  priority: 'normal';
  intent: 'execute';
  idempotencyKey: string;
  freshnessSupplementId: string;
  freshnessSupplementLineageId: string;
  freshnessSupplementSeq: 1 | 2;
  readOnlyToolPolicy: {
    mode: 'read_only';
    replayDeniedToolNames: string[];
  };
}

export interface FreshnessSupplementStartupReconcilerDeps {
  closureStore: Pick<FreshnessClosureStore, 'listRecoverableSupplements' | 'commitSupplement' | 'failSupplement'>;
  messageStore: Pick<IMessageStore, 'getByIdempotencyKey'>;
  enqueue(entry: SupplementQueueCarrier): EnqueueResult;
  executeThread(threadId: string): void | Promise<void>;
  onProjection?(projection: FreshnessSupplementProjection): void | Promise<void>;
  log: StartupRecoveryLogger;
  now?: () => number;
}

export interface FreshnessSupplementStartupRecoveryResult {
  scanned: number;
  recoveredCommitted: number;
  failed: number;
  enqueued: number;
  executedThreads: number;
}

function carrierFor(supplement: FreshnessSupplementAggregate): SupplementQueueCarrier {
  return {
    threadId: supplement.threadId,
    userId: supplement.userId,
    content: `[Freshness Supplement ${supplement.id}] startup recovery`,
    source: 'agent',
    sourceCategory: 'freshness',
    targetCats: [supplement.catId],
    callerCatId: supplement.catId,
    autoExecute: true,
    priority: 'normal',
    intent: 'execute',
    idempotencyKey: supplement.id,
    freshnessSupplementId: supplement.id,
    freshnessSupplementLineageId: supplement.lineageId,
    freshnessSupplementSeq: supplement.seq,
    readOnlyToolPolicy: {
      mode: 'read_only',
      replayDeniedToolNames: supplement.replayUnsafeToolNames,
    },
  };
}

async function emitProjection(
  deps: FreshnessSupplementStartupReconcilerDeps,
  supplement: FreshnessSupplementAggregate,
): Promise<void> {
  if (!deps.onProjection) return;
  try {
    await deps.onProjection(projectFreshnessSupplement(supplement));
  } catch (error) {
    deps.log.warn({ error, supplementId: supplement.id }, '[F254] startup supplement projection failed');
  }
}

async function failCandidate(
  deps: FreshnessSupplementStartupReconcilerDeps,
  supplement: FreshnessSupplementAggregate,
  reason: 'queue_full' | 'scheduler_unavailable' | 'infrastructure',
  now: number,
): Promise<FreshnessSupplementAggregate> {
  const failed = await deps.closureStore.failSupplement(supplement.id, {
    ...(supplement.status === 'running' && supplement.runningInvocationId
      ? { invocationId: supplement.runningInvocationId }
      : {}),
    reason,
    now,
  });
  await emitProjection(deps, failed);
  return failed;
}

interface CandidateOutcome {
  recoveredCommitted: number;
  failed: number;
  enqueued: number;
  executionThreadId?: string;
}

async function reconcileCandidate(
  deps: FreshnessSupplementStartupReconcilerDeps,
  candidate: FreshnessSupplementAggregate,
  now: number,
): Promise<CandidateOutcome> {
  if (candidate.status === 'running') {
    if (!candidate.runningInvocationId) throw new Error('running supplement is missing invocation identity');
    const published = await deps.messageStore.getByIdempotencyKey(candidate.userId, candidate.threadId, candidate.id);
    if (!published) {
      await failCandidate(deps, candidate, 'infrastructure', now);
      return { recoveredCommitted: 0, failed: 1, enqueued: 0 };
    }
    const committed = await deps.closureStore.commitSupplement(candidate.id, {
      invocationId: candidate.runningInvocationId,
      messageId: published.id,
      now,
    });
    await emitProjection(deps, committed);
    return { recoveredCommitted: 1, failed: 0, enqueued: 0 };
  }

  let enqueueResult: EnqueueResult;
  try {
    enqueueResult = deps.enqueue(carrierFor(candidate));
  } catch {
    await failCandidate(deps, candidate, 'scheduler_unavailable', now);
    return { recoveredCommitted: 0, failed: 1, enqueued: 0 };
  }
  if (enqueueResult.outcome === 'full') {
    await failCandidate(deps, candidate, 'queue_full', now);
    return { recoveredCommitted: 0, failed: 1, enqueued: 0 };
  }
  return {
    recoveredCommitted: 0,
    failed: 0,
    enqueued: enqueueResult.deduped ? 0 : 1,
    executionThreadId: candidate.threadId,
  };
}

export async function reconcileFreshnessSupplementsAtStartup(
  deps: FreshnessSupplementStartupReconcilerDeps,
): Promise<FreshnessSupplementStartupRecoveryResult> {
  const now = deps.now?.() ?? Date.now();
  const candidates = await deps.closureStore.listRecoverableSupplements();
  const executionThreads = new Set<string>();
  let recoveredCommitted = 0;
  let failed = 0;
  let enqueued = 0;

  for (const candidate of candidates) {
    const outcome = await reconcileCandidate(deps, candidate, now).catch((error) => {
      deps.log.error(
        { error, supplementId: candidate.id, threadId: candidate.threadId, status: candidate.status },
        '[F254] startup supplement candidate reconciliation failed',
      );
      return null;
    });
    if (!outcome) continue;
    recoveredCommitted += outcome.recoveredCommitted;
    failed += outcome.failed;
    enqueued += outcome.enqueued;
    if (outcome.executionThreadId) executionThreads.add(outcome.executionThreadId);
  }

  let executedThreads = 0;
  for (const threadId of executionThreads) {
    try {
      await deps.executeThread(threadId);
      executedThreads += 1;
    } catch (error) {
      deps.log.error({ error, threadId }, '[F254] startup supplement auto-execute failed');
    }
  }

  const result = {
    scanned: candidates.length,
    recoveredCommitted,
    failed,
    enqueued,
    executedThreads,
  };
  deps.log.info(result, '[F254] startup supplement reconciliation complete');
  return result;
}
