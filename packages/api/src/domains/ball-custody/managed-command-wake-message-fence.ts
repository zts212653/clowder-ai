import { createModuleLogger } from '../../infrastructure/logger.js';
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
type StoredWakeMessage = Awaited<ReturnType<ManagedCommandWakeRecoveryDeps['messageStore']['append']>>;

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
        state: 'message_written',
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

export async function publishManagedCommandWakeMessage(
  deps: Pick<ManagedCommandWakeRecoveryDeps, 'dynamicTaskStore' | 'messageStore' | 'socketManager'>,
  parsed: ParsedManagedCommandWakeTask,
  now: () => number,
): Promise<boolean> {
  if (!parsed.command.wakeContent) return false;
  const claimed = claimManagedCommandWakeMessageContent(deps.dynamicTaskStore, parsed, now());
  if (!claimed?.command.wakeContent) return false;
  const triggerContent = `[定时任务] ${claimed.command.wakeContent}`;
  const idempotencyKey = `${COMPLETION_MESSAGE_KEY_PREFIX}${claimed.task.id}`;

  try {
    const existing = await deps.messageStore.getByIdempotencyKey('scheduler', claimed.threadId, idempotencyKey);
    const stored =
      existing ??
      (await deps.messageStore.append({
        userId: 'scheduler',
        catId: null,
        content: triggerContent,
        mentions: [],
        timestamp: now(),
        threadId: claimed.threadId,
        deliveryStatus: 'queued',
        idempotencyKey,
        source: {
          connector: 'hold-ball',
          label: '持球通知',
          icon: '🏓',
          meta: { taskId: claimed.task.id, threadId: claimed.threadId, catId: claimed.catId, wakeWhen: true },
        },
      }));

    if (!existing) broadcastStoredMessage(deps.socketManager, claimed.threadId, stored);
    return commitManagedCommandWakeMessageVisibility(
      deps.dynamicTaskStore,
      claimed.task.id,
      claimed.command.messageClaimGeneration,
      stored.id,
      now(),
    );
  } catch (err) {
    let committedAfterError: StoredWakeMessage | null;
    try {
      committedAfterError = await deps.messageStore.getByIdempotencyKey('scheduler', claimed.threadId, idempotencyKey);
    } catch (lookupErr) {
      log.warn(
        { err: lookupErr, taskId: claimed.task.id, threadId: claimed.threadId },
        'managed-command message outcome is uncertain; retaining the durable content claim for recovery',
      );
      return false;
    }
    if (committedAfterError) {
      broadcastStoredMessage(deps.socketManager, claimed.threadId, committedAfterError);
      return commitManagedCommandWakeMessageVisibility(
        deps.dynamicTaskStore,
        claimed.task.id,
        claimed.command.messageClaimGeneration,
        committedAfterError.id,
        now(),
      );
    }
    releaseManagedCommandWakeMessageContentClaim(
      deps.dynamicTaskStore,
      claimed.task.id,
      claimed.command.messageClaimGeneration,
    );
    log.warn(
      { err, taskId: claimed.task.id, threadId: claimed.threadId },
      'managed-command completion persisted but thread delivery is pending',
    );
    return false;
  }
}

function broadcastStoredMessage(
  socketManager: ManagedCommandWakeRecoveryDeps['socketManager'],
  threadId: string,
  stored: StoredWakeMessage,
): void {
  socketManager.broadcastToRoom(`thread:${threadId}`, 'connector_message', {
    threadId,
    message: {
      id: stored.id,
      type: 'connector',
      content: stored.content,
      source: stored.source,
      timestamp: stored.timestamp,
    },
  });
}
