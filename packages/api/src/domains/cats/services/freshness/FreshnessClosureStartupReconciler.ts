import type { FreshnessClosureAggregate, FreshnessClosureProjection } from '@cat-cafe/shared';
import type { EnqueueResult } from '../agents/invocation/InvocationQueue.js';
import type { FreshnessClosureStore } from './FreshnessClosureStore.js';
import { recordFreshnessClosureTransition } from './freshness-closure-telemetry.js';
import { projectFreshnessClosure } from './glass-box/FreshnessOutputCommitCoordinator.js';

export const DEFAULT_RUNNING_RECOVERY_MAX_AGE_MS = 60 * 60_000;

interface StartupRecoveryLogger {
  info(fields: unknown, message?: string): void;
  warn(fields: unknown, message?: string): void;
  error(fields: unknown, message?: string): void;
}

export interface FreshnessClosureStartupReconcilerDeps {
  closureStore: Pick<FreshnessClosureStore, 'listRecoverable' | 'recoverAttempt' | 'blockRecovery'>;
  enqueue(closure: FreshnessClosureAggregate): EnqueueResult;
  executeThread(threadId: string): void | Promise<void>;
  onProjection?(projection: FreshnessClosureProjection): void | Promise<void>;
  log: StartupRecoveryLogger;
  now?: () => number;
  maxRunningAttemptAgeMs?: number;
}

export interface FreshnessClosureStartupRecoveryResult {
  scanned: number;
  recovered: number;
  blocked: number;
  enqueued: number;
  executedThreads: number;
}

interface CandidateRecoveryOutcome {
  recovered: number;
  blocked: number;
  enqueued: number;
  recoveredThreadId?: string;
}

async function emitBlockedProjection(
  deps: FreshnessClosureStartupReconcilerDeps,
  closure: FreshnessClosureAggregate,
): Promise<void> {
  if (!deps.onProjection) return;
  try {
    await deps.onProjection(projectFreshnessClosure(closure, 'blocked'));
  } catch (error) {
    deps.log.warn({ error, closureId: closure.id }, '[F254-E] startup blocked projection failed');
  }
}

async function blockStartupRecovery(
  deps: FreshnessClosureStartupReconcilerDeps,
  closure: FreshnessClosureAggregate,
  evidenceRefs: string[],
  now: number,
): Promise<FreshnessClosureAggregate> {
  const blocked = await deps.closureStore.blockRecovery(closure.id, { evidenceRefs, now });
  recordFreshnessClosureTransition('blocked');
  await emitBlockedProjection(deps, blocked);
  deps.log.warn(
    { closureId: blocked.id, threadId: blocked.threadId, catId: blocked.catId, evidenceRefs },
    '[F254-E] startup closure recovery requires explicit retry',
  );
  return blocked;
}

async function reconcileStartupCandidate(
  deps: FreshnessClosureStartupReconcilerDeps,
  candidate: FreshnessClosureAggregate,
  now: number,
  maxRunningAttemptAgeMs: number,
): Promise<CandidateRecoveryOutcome> {
  if (candidate.status === 'pending') {
    await blockStartupRecovery(deps, candidate, ['startup:pending_requires_explicit_retry'], now);
    return { recovered: 0, blocked: 1, enqueued: 0 };
  }

  const attemptAgeMs = candidate.activeAttempt
    ? Math.max(0, now - candidate.activeAttempt.startedAt)
    : Number.POSITIVE_INFINITY;
  if (attemptAgeMs > maxRunningAttemptAgeMs) {
    await blockStartupRecovery(deps, candidate, ['startup:running_attempt_expired', `age-ms:${attemptAgeMs}`], now);
    return { recovered: 0, blocked: 1, enqueued: 0 };
  }

  const closure = await deps.closureStore.recoverAttempt(candidate.id, {
    evidenceRef: 'startup:recent_running_recovery',
    now,
  });
  const enqueueResult = deps.enqueue(closure);
  if (enqueueResult.outcome === 'full') {
    await blockStartupRecovery(deps, closure, ['startup:queue_full'], now);
    return { recovered: 0, blocked: 1, enqueued: 0 };
  }
  return {
    recovered: 1,
    blocked: 0,
    enqueued: enqueueResult.deduped ? 0 : 1,
    recoveredThreadId: closure.threadId,
  };
}

export async function reconcileFreshnessClosuresAtStartup(
  deps: FreshnessClosureStartupReconcilerDeps,
): Promise<FreshnessClosureStartupRecoveryResult> {
  const now = deps.now?.() ?? Date.now();
  const maxRunningAttemptAgeMs = deps.maxRunningAttemptAgeMs ?? DEFAULT_RUNNING_RECOVERY_MAX_AGE_MS;
  const candidates = await deps.closureStore.listRecoverable();
  const recoveredThreads = new Set<string>();
  let recovered = 0;
  let blocked = 0;
  let enqueued = 0;

  for (const candidate of candidates) {
    const outcome = await reconcileStartupCandidate(deps, candidate, now, maxRunningAttemptAgeMs).catch((error) => {
      deps.log.error(
        { error, closureId: candidate.id, threadId: candidate.threadId, catId: candidate.catId },
        '[F254-E] startup closure candidate reconciliation failed',
      );
      return null;
    });
    if (!outcome) continue;
    recovered += outcome.recovered;
    blocked += outcome.blocked;
    enqueued += outcome.enqueued;
    if (outcome.recoveredThreadId) recoveredThreads.add(outcome.recoveredThreadId);
  }

  let executedThreads = 0;
  for (const threadId of recoveredThreads) {
    const executed = await Promise.resolve()
      .then(() => deps.executeThread(threadId))
      .then(
        () => true,
        (error) => {
          deps.log.error({ error, threadId }, '[F254-E] startup closure auto-execute failed');
          return false;
        },
      );
    if (executed) executedThreads += 1;
  }

  const result = {
    scanned: candidates.length,
    recovered,
    blocked,
    enqueued,
    executedThreads,
  };
  deps.log.info(result, '[F254-E] startup closure reconciliation complete');
  return result;
}
