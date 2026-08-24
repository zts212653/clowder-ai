import type { CatId } from '@cat-cafe/shared';
import type { QueuedMessageCustody, StoredMessage } from '../../stores/ports/MessageStore.js';
import { settleQueueCustodyWithdrawal } from '../../stores/ports/queued-message-custody.js';
import { resolveReplacedA2ATargetCats } from './QueuedMessageCustodyA2ARestartPreflight.js';
import { resolveRestartTargets } from './QueuedMessageCustodyRestartTargets.js';
import { projectRuntimeRestartAttempts } from './QueuedMessageCustodyRuntimeRestartAttempts.js';
import { resolveRestartReminderAttempts } from './QueuedMessageCustodyStartupProjectionHelpers.js';
import type { StartupCustodyDeps } from './QueuedMessageCustodyStartupTypes.js';

export interface RestartProjectionResult {
  next: QueuedMessageCustody;
  handledTargets: number;
  failedTargets: number;
  recoveryDeferred?: boolean;
}

export async function buildRestartProjection(
  deps: StartupCustodyDeps,
  message: StoredMessage,
  current: QueuedMessageCustody,
  now: number,
): Promise<RestartProjectionResult> {
  const replacementPreflight = await resolveReplacedA2ATargetCats(
    message,
    current,
    deps.a2aDispatchDispositionService,
    deps.messageStore,
    deps.log,
  );
  if (replacementPreflight.recoveryDeferred) {
    return { next: current, handledTargets: 0, failedTargets: 0, recoveryDeferred: true };
  }
  const { replacedTargetCats: replacedA2ATargetCats } = replacementPreflight;
  const target = await resolveRestartTargets(
    message,
    current,
    deps.messageStore,
    deps.invocationRecordStore,
    deps.turnExecutionStore,
    replacedA2ATargetCats,
    now,
  );
  // Body-read truth is stronger than reminder transport state. Resolve it
  // first, then close attempts owned by the vanished runtime.
  const reminderProjection = resolveRestartReminderAttempts(current, now, target.live);
  const targetAttempts = projectRuntimeRestartAttempts(current, target.interrupted, now);
  const authorIntentByCatId = current.authorIntentByCatId ? structuredClone(current.authorIntentByCatId) : undefined;
  if (authorIntentByCatId) {
    for (const catId of target.pending) {
      if (replacedA2ATargetCats.has(catId) || target.live.has(catId)) continue;
      const authorIntent = authorIntentByCatId[catId];
      if (
        authorIntent?.requested !== 'continue_current' ||
        authorIntent.fallbackAt !== undefined ||
        !authorIntent.boundParentInvocationId
      ) {
        continue;
      }
      const hadExposure = (current.bodyExposures ?? []).some((exposure) => exposure.targetCatId === catId);
      authorIntentByCatId[catId] = {
        ...authorIntent,
        fallbackAt: now,
        fallbackReason: hadExposure ? 'parent_non_success_after_exposure' : 'parent_terminal_before_exposure',
      };
    }
  }

  for (const catId of current.steerRequestedByCatIds ?? []) {
    if (replacedA2ATargetCats.has(catId) || !target.pending.has(catId) || target.live.has(catId)) continue;
    target.failed.add(catId);
    target.failedTargets += 1;
  }

  const terminal = target.pending.size === 0;
  const hasLiveAcceptedTarget = target.live.size > 0;
  const {
    processingStartedAt: _processingStartedAt,
    awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
    awakenedAtByCatId: _awakenedAtByCatId,
    steerRequestedByCatIds: _steerRequestedByCatIds,
    steeredInvocationIdByCatId: _steeredInvocationIdByCatId,
    carrierStateByTargetCatId: _carrierStateByTargetCatId,
    ...stableCurrent
  } = current;
  const carrierStateByTargetCatId = Object.fromEntries(
    [...target.pending].map((catId) => {
      if (!target.live.has(catId)) return [catId, { status: 'queued' as const }];
      const currentCarrierState = current.carrierStateByTargetCatId?.[catId];
      return [
        catId,
        {
          status: 'processing' as const,
          processingStartedAt:
            currentCarrierState?.processingStartedAt ?? current.processingStartedAt ?? current.updatedAt,
        },
      ];
    }),
  );
  const nextBeforeReplacementWithdrawal: QueuedMessageCustody = {
    ...stableCurrent,
    // Replacement withdrawal owns the one allowed revision increment.
    revision: current.revision + (replacedA2ATargetCats.size > 0 ? 0 : 1),
    status: terminal ? 'terminal' : hasLiveAcceptedTarget ? 'processing' : 'queued',
    ...(hasLiveAcceptedTarget ? { processingStartedAt: current.processingStartedAt ?? current.updatedAt } : {}),
    ...(authorIntentByCatId ? { authorIntentByCatId } : {}),
    pendingTargetCats: [...target.pending] as CatId[],
    notifiedByCatIds: [...target.notified] as CatId[],
    ...(Object.keys(target.awakenedInvocationIdByCatId).length > 0
      ? { awakenedInvocationIdByCatId: target.awakenedInvocationIdByCatId }
      : {}),
    ...(Object.keys(target.awakenedAtByCatId).length > 0 ? { awakenedAtByCatId: target.awakenedAtByCatId } : {}),
    seenInvocationIdByCatId: target.seenInvocationIdByCatId,
    failedByCatIds: [...target.failed] as CatId[],
    handledByCatIds: [...target.handled] as CatId[],
    targetOutcomeByCatId: target.targetOutcomeByCatId,
    ...(targetAttempts && targetAttempts.length > 0 ? { targetAttempts } : {}),
    ...(Object.keys(carrierStateByTargetCatId).length > 0 ? { carrierStateByTargetCatId } : {}),
    ...(reminderProjection.reminderAttempts ? { reminderAttempts: reminderProjection.reminderAttempts } : {}),
    updatedAt: now,
  };
  const next =
    replacedA2ATargetCats.size > 0
      ? settleQueueCustodyWithdrawal(nextBeforeReplacementWithdrawal, [...replacedA2ATargetCats], now)
      : nextBeforeReplacementWithdrawal;
  return {
    next,
    handledTargets: target.handledTargets,
    failedTargets: target.failedTargets,
  };
}
