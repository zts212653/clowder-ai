import type { CatId } from '@cat-cafe/shared';
import {
  WaitContinuationCarrierError,
  waitContinuationCarrierFromStoredMessage,
} from '../../../../ball-custody/wait-continuation-carrier.js';
import type { QueuedMessageCustody, StoredMessage } from '../../stores/ports/MessageStore.js';
import { buildRestartProjection } from './QueuedMessageCustodyRestartProjector.js';
import {
  resolveRestartReminderAttempts,
  sameActiveProjection,
  uniqueCatIds,
} from './QueuedMessageCustodyStartupProjectionHelpers.js';
import type { ReconciledMessage, StartupCustodyDeps } from './QueuedMessageCustodyStartupTypes.js';

export async function initializeLegacyCustody(
  deps: StartupCustodyDeps,
  message: StoredMessage,
  now: number,
): Promise<{ message: StoredMessage; backfilled: boolean } | null> {
  const explicitTargets = message.extra?.targetCats?.filter((value): value is string => typeof value === 'string');
  const targets = uniqueCatIds(explicitTargets?.length ? explicitTargets : message.mentions);
  if (targets.length === 0) {
    deps.log.warn(
      `[queue-custody-startup] cannot restore legacy queued message without target identity: ${message.id}`,
    );
    return null;
  }
  const custody: QueuedMessageCustody = {
    version: 1,
    entryId: `legacy:${message.id}`,
    revision: 1,
    ownerUserId: message.userId,
    intent: 'execute',
    status: 'queued',
    allTargetCats: targets,
    pendingTargetCats: targets,
    notifiedByCatIds: [],
    seenByCatIds: [],
    seenInvocationIdByCatId: {},
    failedByCatIds: [],
    handledByCatIds: [],
    priority: 'normal',
    createdAt: message.timestamp,
    updatedAt: now,
  };
  const initialized = await deps.messageStore.initializeQueueCustody(message.id, custody);
  if (initialized.kind === 'not_found' || initialized.kind === 'not_queued') return null;
  return { message: initialized.message, backfilled: initialized.kind === 'initialized' };
}

export async function reconcileStartupCustodyMessage(
  deps: StartupCustodyDeps,
  messageId: string,
  now: () => number,
): Promise<ReconciledMessage | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const message = await deps.messageStore.getById(messageId);
    const current = message?.queueCustody;
    if (!message || message.deliveryStatus !== 'queued' || !current) return null;
    if (current.status === 'terminal' && (current.withdrawnByCatIds?.length ?? 0) > 0) {
      return { message, terminalized: true, handledTargets: 0, failedTargets: 0 };
    }
    const built = await buildRestartProjection(deps, message, current, now());
    if (sameActiveProjection(current, built.next)) {
      return {
        message,
        terminalized: false,
        handledTargets: 0,
        failedTargets: 0,
        ...(built.recoveryDeferred ? { recoveryDeferred: true } : {}),
      };
    }
    const result = await deps.messageStore.transitionQueueCustody(messageId, {
      expectedRevision: current.revision,
      next: built.next,
      ...(built.next.status === 'terminal' ? { deliveredAt: now() } : {}),
    });
    if (result.kind === 'revision_mismatch') continue;
    if (result.kind === 'not_found') return null;
    return {
      message: result.message,
      terminalized: result.message.queueCustody?.status === 'terminal',
      handledTargets: built.handledTargets,
      failedTargets: built.failedTargets,
      ...(built.recoveryDeferred ? { recoveryDeferred: true } : {}),
    };
  }
  throw new Error(`queue custody startup CAS retries exhausted for message ${messageId}`);
}

export async function terminalizeLegacyUnfencedWait(
  deps: StartupCustodyDeps,
  messageId: string,
  now: () => number,
): Promise<{ terminalized: boolean; failedTargets: number }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const message = await deps.messageStore.getById(messageId);
    const current = message?.queueCustody;
    if (!message || message.deliveryStatus !== 'queued' || !current || current.status === 'terminal') {
      return { terminalized: false, failedTargets: 0 };
    }
    try {
      waitContinuationCarrierFromStoredMessage(message);
      return { terminalized: false, failedTargets: 0 };
    } catch (error) {
      if (!(error instanceof WaitContinuationCarrierError)) throw error;
    }
    const timestamp = now();
    const failedTargetCats = uniqueCatIds([...current.failedByCatIds, ...current.pendingTargetCats]);
    const reminderProjection = resolveRestartReminderAttempts(current, timestamp);
    const {
      processingStartedAt: _processingStartedAt,
      awakenedInvocationIdByCatId: _awakenedInvocationIdByCatId,
      awakenedAtByCatId: _awakenedAtByCatId,
      steerRequestedByCatIds: _steerRequestedByCatIds,
      steeredInvocationIdByCatId: _steeredInvocationIdByCatId,
      carrierStateByTargetCatId: _carrierStateByTargetCatId,
      reminderAttempts: _reminderAttempts,
      ...stableCurrent
    } = current;
    const result = await deps.messageStore.transitionQueueCustody(messageId, {
      expectedRevision: current.revision,
      next: {
        ...stableCurrent,
        revision: current.revision + 1,
        status: 'terminal',
        pendingTargetCats: [],
        failedByCatIds: failedTargetCats as CatId[],
        ...(reminderProjection.reminderAttempts ? { reminderAttempts: reminderProjection.reminderAttempts } : {}),
        updatedAt: timestamp,
      },
      deliveredAt: timestamp,
    });
    if (result.kind === 'revision_mismatch') continue;
    if (result.kind === 'not_found') return { terminalized: false, failedTargets: 0 };
    return { terminalized: true, failedTargets: current.pendingTargetCats.length };
  }
  throw new Error(`legacy wait terminalization CAS retries exhausted for message ${messageId}`);
}
