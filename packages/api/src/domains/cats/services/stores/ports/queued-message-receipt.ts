import type {
  QueueMessageReceipt,
  QueueReminderAttempt,
  QueueReminderMissedReason,
  QueueTargetOutcome,
} from '@cat-cafe/shared';
import { cloneQueuedMessageCustody, type QueuedMessageCustody } from './queued-message-custody.js';

export interface RequestReminderAttemptInput {
  id: string;
  targetCatId: string;
  invocationId: string;
  requestedAt: number;
}

interface QueueReceiptProjectionSets {
  handled: ReadonlySet<string>;
  withdrawn: ReadonlySet<string>;
  steering: Readonly<Record<string, string>>;
  steeringRequested: ReadonlySet<string>;
  failed: ReadonlySet<string>;
  seen: ReadonlySet<string>;
  awakened: Readonly<Record<string, string>>;
  notified: ReadonlySet<string>;
}

function latestExposure(
  custody: QueuedMessageCustody,
  catId: string,
  invocationId?: string,
): NonNullable<QueuedMessageCustody['bodyExposures']>[number] | undefined {
  let latest: NonNullable<QueuedMessageCustody['bodyExposures']>[number] | undefined;
  for (const exposure of custody.bodyExposures ?? []) {
    if (exposure.targetCatId !== catId) continue;
    if (invocationId !== undefined && exposure.invocationId !== invocationId) continue;
    // Exposure history is append-only. When two reads share one millisecond,
    // the later appended child is the deterministic successor.
    if (!latest || exposure.seenAt >= latest.seenAt) latest = exposure;
  }
  return latest;
}

function projectQueueReceiptTarget(
  custody: QueuedMessageCustody,
  catId: string,
  state: QueueReceiptProjectionSets,
): QueueMessageReceipt['targets'][number] {
  const outcome: QueueTargetOutcome | undefined = custody.targetOutcomeByCatId?.[catId];
  const authorIntent = custody.authorIntentByCatId?.[catId];
  const authorIntentProjection = authorIntent
    ? {
        authorIntent: {
          ...authorIntent,
          effective: authorIntent.fallbackAt === undefined ? authorIntent.requested : ('next_work' as const),
        },
      }
    : {};
  if (state.handled.has(catId)) {
    const exposure = outcome ? latestExposure(custody, catId, outcome.invocationId) : undefined;
    return {
      catId,
      state: 'handled',
      ...authorIntentProjection,
      ...(exposure ? { invocationId: exposure.invocationId, seenAt: exposure.seenAt } : {}),
      ...(outcome ? { outcome } : {}),
    };
  }
  if (state.withdrawn.has(catId)) {
    const exposure = latestExposure(custody, catId);
    return {
      catId,
      state: 'withdrawn',
      ...authorIntentProjection,
      withdrawnAt: custody.withdrawnAtByCatId?.[catId],
      ...(exposure ? { invocationId: exposure.invocationId, seenAt: exposure.seenAt } : {}),
    };
  }
  if (state.steering[catId]) {
    const exposure = latestExposure(custody, catId, state.steering[catId]);
    return {
      catId,
      state: 'steering',
      ...authorIntentProjection,
      invocationId: state.steering[catId],
      ...(exposure ? { seenAt: exposure.seenAt } : {}),
    };
  }
  if (state.steeringRequested.has(catId)) return { catId, state: 'steering', ...authorIntentProjection };
  if (state.failed.has(catId)) {
    const exposure = latestExposure(custody, catId);
    const awakenedInvocationId = custody.awakenedInvocationIdByCatId?.[catId];
    const awakenedAt = custody.awakenedAtByCatId?.[catId];
    return {
      catId,
      state: 'failed',
      ...authorIntentProjection,
      ...(exposure
        ? { invocationId: exposure.invocationId, seenAt: exposure.seenAt }
        : awakenedInvocationId
          ? { invocationId: awakenedInvocationId, ...(awakenedAt !== undefined ? { awakenedAt } : {}) }
          : {}),
    };
  }
  if (state.seen.has(catId)) {
    const invocationId = custody.seenInvocationIdByCatId[catId];
    const exposure = invocationId ? latestExposure(custody, catId, invocationId) : latestExposure(custody, catId);
    return {
      catId,
      state: 'seen',
      ...authorIntentProjection,
      ...(invocationId ? { invocationId } : exposure ? { invocationId: exposure.invocationId } : {}),
      ...(exposure ? { seenAt: exposure.seenAt } : {}),
    };
  }
  if (state.awakened[catId]) {
    const awakenedAt = custody.awakenedAtByCatId?.[catId];
    return {
      catId,
      state: 'awakened',
      ...authorIntentProjection,
      invocationId: state.awakened[catId],
      ...(awakenedAt !== undefined ? { awakenedAt } : {}),
    };
  }
  if (state.notified.has(catId)) return { catId, state: 'notified', ...authorIntentProjection };
  return { catId, state: 'queued', ...authorIntentProjection };
}

export function projectQueueReceipt(custody: QueuedMessageCustody): QueueMessageReceipt {
  const state: QueueReceiptProjectionSets = {
    handled: new Set<string>(custody.handledByCatIds),
    withdrawn: new Set<string>(custody.withdrawnByCatIds ?? []),
    steering: custody.steeredInvocationIdByCatId ?? {},
    steeringRequested: new Set<string>(custody.steerRequestedByCatIds ?? []),
    failed: new Set<string>(custody.failedByCatIds),
    seen: new Set<string>(custody.seenByCatIds),
    awakened: custody.awakenedInvocationIdByCatId ?? {},
    notified: new Set<string>(custody.notifiedByCatIds),
  };
  return {
    version: 1,
    entryId: custody.entryId,
    ...(custody.receiptScope ? { scope: custody.receiptScope } : {}),
    targets: custody.allTargetCats.map((catId) => projectQueueReceiptTarget(custody, catId, state)),
    reminderAttempts: (custody.reminderAttempts ?? []).map((attempt) => ({ ...attempt })),
  };
}

export function requestReminderAttempt(
  custody: QueuedMessageCustody,
  input: RequestReminderAttemptInput,
): QueuedMessageCustody {
  if (!custody.allTargetCats.includes(input.targetCatId as (typeof custody.allTargetCats)[number])) {
    throw new Error('reminder target cat is not part of queue custody');
  }
  const attempts = custody.reminderAttempts ?? [];
  if (
    attempts.some((attempt) => attempt.targetCatId === input.targetCatId && attempt.invocationId === input.invocationId)
  ) {
    return custody;
  }
  const next = cloneQueuedMessageCustody(custody);
  next.reminderAttempts = [
    ...(next.reminderAttempts ?? []),
    {
      id: input.id,
      targetCatId: input.targetCatId,
      invocationId: input.invocationId,
      state: 'requested',
      requestedAt: input.requestedAt,
    },
  ];
  return next;
}

function updateReminderAttempts(
  custody: QueuedMessageCustody,
  update: (attempt: QueueReminderAttempt) => QueueReminderAttempt,
): QueuedMessageCustody {
  let changed = false;
  const attempts = (custody.reminderAttempts ?? []).map((attempt) => {
    const next = update(attempt);
    changed = changed || next !== attempt;
    return next;
  });
  if (!changed) return custody;
  const next = cloneQueuedMessageCustody(custody);
  next.reminderAttempts = attempts;
  return next;
}

export function markReminderAttemptDelivered(
  custody: QueuedMessageCustody,
  targetCatId: string,
  invocationId: string,
  deliveredAt: number,
): QueuedMessageCustody {
  return updateReminderAttempts(custody, (attempt) =>
    attempt.targetCatId === targetCatId && attempt.invocationId === invocationId && attempt.state === 'requested'
      ? { ...attempt, state: 'delivered', deliveredAt }
      : attempt,
  );
}

export function markReminderAttemptSeen(
  custody: QueuedMessageCustody,
  targetCatId: string,
  invocationId: string,
  seenAt: number,
): QueuedMessageCustody {
  return updateReminderAttempts(custody, (attempt) => {
    if (
      attempt.targetCatId !== targetCatId ||
      attempt.invocationId !== invocationId ||
      (attempt.state !== 'requested' && attempt.state !== 'delivered')
    ) {
      return attempt;
    }
    return {
      ...attempt,
      state: 'seen',
      ...(attempt.deliveredAt !== undefined ? { deliveredAt: attempt.deliveredAt } : {}),
      seenAt,
    };
  });
}

export function markReminderAttemptMissed(
  custody: QueuedMessageCustody,
  invocationId: string,
  missedAt: number,
): QueuedMessageCustody {
  return updateReminderAttempts(custody, (attempt) => {
    if (attempt.invocationId !== invocationId || (attempt.state !== 'requested' && attempt.state !== 'delivered')) {
      return attempt;
    }
    const missedReason: QueueReminderMissedReason =
      attempt.state === 'delivered' ? 'delivered_not_read' : 'invocation_ended_before_delivery';
    return { ...attempt, state: 'missed', missedAt, missedReason };
  });
}
