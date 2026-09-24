import { parseWaitOwnerFence } from '@cat-cafe/shared';
import { createModuleLogger } from '../../infrastructure/logger.js';
import {
  type ManagedCommandWakeActionLeaseAdmission,
  resolveManagedCommandWakeActionLeaseAdmission,
} from './managed-command-wake-action-lease-admission.js';
import type {
  ManagedCommandWakeDynamicTaskStore,
  ManagedCommandWakeProjection,
  ManagedCommandWakeRecoveryDeps,
  ParsedManagedCommandWakeTask,
} from './managed-command-wake-lifecycle.js';
import { parseManagedCommandWakeTask } from './managed-command-wake-lifecycle.js';

const log = createModuleLogger('ball-custody/managed-command-wake-message-fence');
const COMPLETION_MESSAGE_KEY_PREFIX = 'hold-ball-completion:';
const MESSAGE_CLAIM_STALE_MS = 30_000;

function readManagedCommandWakeActionLeaseRef(
  parsed: ParsedManagedCommandWakeTask,
): { leaseId: string; generation: number } | undefined {
  const awaiting = parsed.lifecycle.await;
  if (!awaiting || typeof awaiting !== 'object' || Array.isArray(awaiting)) return undefined;
  const ownerFence = parseWaitOwnerFence((awaiting as Record<string, unknown>).ownerFence);
  return ownerFence?.kind === 'action_successor'
    ? { leaseId: ownerFence.leaseId, generation: ownerFence.generation }
    : undefined;
}

function updateCommand(
  store: ManagedCommandWakeDynamicTaskStore,
  parsed: ParsedManagedCommandWakeTask,
  command: ManagedCommandWakeProjection,
): boolean {
  return store.updateParamsIfCurrent(parsed.task.id, parsed.task.params, {
    ...parsed.task.params,
    holdLifecycle: {
      ...parsed.lifecycle,
      managedCommand: command,
    },
  });
}

function claimManagedCommandWakeMessageContent(
  store: ManagedCommandWakeDynamicTaskStore,
  parsed: ParsedManagedCommandWakeTask,
  now: number,
): ParsedManagedCommandWakeTask | null {
  const claimedAt = parsed.command.messageClaimedAt;
  if (claimedAt !== undefined && now - claimedAt < MESSAGE_CLAIM_STALE_MS) return null;
  const nextGeneration = (parsed.command.messageClaimGeneration ?? 0) + 1;
  if (
    !updateCommand(store, parsed, {
      ...parsed.command,
      messageClaimGeneration: nextGeneration,
      messageClaimedAt: now,
    })
  ) {
    return null;
  }
  return parseManagedCommandWakeTask(store.getById(parsed.task.id));
}

function commitManagedCommandWakeMessageVisibility(
  store: ManagedCommandWakeDynamicTaskStore,
  taskId: string,
  claimGeneration: number | undefined,
  messageId: string,
  now: number,
): boolean {
  if (claimGeneration === undefined) return false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const latest = parseManagedCommandWakeTask(store.getById(taskId));
    if (
      !latest ||
      latest.command.state !== 'condition_met' ||
      latest.command.messageClaimGeneration !== claimGeneration
    ) {
      return false;
    }
    const { messageClaimedAt: _claimedAt, pendingCompletionContent: _pending, ...selected } = latest.command;
    if (
      updateCommand(store, latest, {
        ...selected,
        // Message and Queue row committed in one transaction, so there is no `message_written`
        // stage left to be in: the wake is durable the moment this returns.
        state: 'enqueued',
        messageId,
        messageWrittenAt: latest.command.messageWrittenAt ?? now,
      })
    ) {
      return true;
    }
  }
  return false;
}

function releaseManagedCommandWakeMessageContentClaim(
  store: ManagedCommandWakeDynamicTaskStore,
  taskId: string,
  claimGeneration: number | undefined,
): void {
  if (claimGeneration === undefined) return;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const latest = parseManagedCommandWakeTask(store.getById(taskId));
    if (
      !latest ||
      latest.command.state !== 'condition_met' ||
      latest.command.messageId ||
      latest.command.messageClaimGeneration !== claimGeneration
    ) {
      return;
    }
    const { messageClaimedAt: _claimedAt, pendingCompletionContent, ...released } = latest.command;
    const command: ManagedCommandWakeProjection = pendingCompletionContent
      ? {
          ...released,
          wakeContent: pendingCompletionContent,
          wakeSource: 'command_completion',
        }
      : released;
    if (updateCommand(store, latest, command)) return;
  }
}

/**
 * `lease_rejected` is permanent, `retry` is not. The distinction matters because the lease is now
 * checked before the write: a stale generation leaves nothing to cancel, so the task has to be
 * retired on this signal rather than by reconciling a message that was never created.
 */
export type ManagedCommandWakePublishResult = 'published' | 'retry' | 'lease_rejected';

export async function publishManagedCommandWakeMessage(
  deps: Pick<
    ManagedCommandWakeRecoveryDeps,
    'dynamicTaskStore' | 'messageStore' | 'admitWake' | 'actionSuccessorLeaseStore'
  >,
  parsed: ParsedManagedCommandWakeTask,
  now: () => number,
): Promise<ManagedCommandWakePublishResult> {
  if (!parsed.command.wakeContent) return 'retry';
  const claimed = claimManagedCommandWakeMessageContent(deps.dynamicTaskStore, parsed, now());
  if (!claimed?.command.wakeContent) return 'retry';
  const triggerContent = `[定时任务] ${claimed.command.wakeContent}`;
  const idempotencyKey = `${COMPLETION_MESSAGE_KEY_PREFIX}${claimed.task.id}`;
  const actionLeaseRef = readManagedCommandWakeActionLeaseRef(claimed);
  const source = {
    connector: 'hold-ball',
    label: '持球通知',
    icon: '🏓',
    meta: {
      managedHold: true,
      phase: 'wake',
      cancelable: false,
      taskId: claimed.task.id,
      threadId: claimed.threadId,
      catId: claimed.catId,
      wakeWhen: true,
      ...(actionLeaseRef ? { actionLeaseRef } : {}),
    },
  } as const;

  // The lease is verified against the envelope BEFORE anything is written. It used to be checked
  // inside the trigger, i.e. after the message was already durable, which is the only reason a
  // rejected generation ever needed `markCanceled` to undo a message that should not have existed.
  let admission: ManagedCommandWakeActionLeaseAdmission;
  try {
    admission = await resolveManagedCommandWakeActionLeaseAdmission(
      { threadId: claimed.threadId, source },
      { threadId: claimed.threadId, catId: claimed.catId, tenantScope: claimed.userId },
      deps.actionSuccessorLeaseStore,
    );
  } catch (err) {
    releaseManagedCommandWakeMessageContentClaim(
      deps.dynamicTaskStore,
      claimed.task.id,
      claimed.command.messageClaimGeneration,
    );
    log.warn(
      { err, taskId: claimed.task.id, threadId: claimed.threadId },
      'managed-command wake refused: action lease generation no longer matches; nothing was written',
    );
    return 'lease_rejected';
  }

  try {
    const admitted = await deps.admitWake({
      message: {
        from: { kind: 'system', service: 'managed-command-wake' },
        userId: claimed.userId,
        content: triggerContent,
        mentions: [],
        timestamp: now(),
        threadId: claimed.threadId,
        deliveryStatus: 'queued',
        idempotencyKey,
        source,
      },
      threadId: claimed.threadId,
      userId: claimed.userId,
      catId: claimed.catId,
      content: triggerContent,
      // A managed hold's owner is waiting on this exact wake, so it is urgent and files as
      // scheduled work. Stated here by the producer rather than hardcoded at the admission site.
      priority: 'urgent',
      sourceCategory: 'scheduled',
      ...(admission.actionSuccessorFence ? { actionSuccessorFence: admission.actionSuccessorFence } : {}),
    });
    if (!admitted.messageId) {
      releaseManagedCommandWakeMessageContentClaim(
        deps.dynamicTaskStore,
        claimed.task.id,
        claimed.command.messageClaimGeneration,
      );
      return 'retry';
    }
    return commitManagedCommandWakeMessageVisibility(
      deps.dynamicTaskStore,
      claimed.task.id,
      claimed.command.messageClaimGeneration,
      admitted.messageId,
      now(),
    )
      ? 'published'
      : 'retry';
  } catch (err) {
    // One transaction: it either committed both halves or neither. There is no appended message to
    // reconcile afterwards, so the claim is simply released and the next sweep retries.
    releaseManagedCommandWakeMessageContentClaim(
      deps.dynamicTaskStore,
      claimed.task.id,
      claimed.command.messageClaimGeneration,
    );
    log.warn(
      { err, taskId: claimed.task.id, threadId: claimed.threadId },
      'managed-command wake admission failed; nothing was written and the wake stays retryable',
    );
    return 'retry';
  }
}
