import { createModuleLogger } from '../../infrastructure/logger.js';
import type { DynamicTaskDef } from '../../infrastructure/scheduler/DynamicTaskStore.js';
import {
  type ManagedCommandWakeDynamicTaskStore,
  type ManagedCommandWakeProjection,
  type ManagedCommandWakeRecoveryDeps,
  type ManagedCommandWakeRecoveryResult,
  normalizeManagedCommandTerminalResult,
  type ParsedManagedCommandWakeTask,
  parseRetiredManagedCommandWakeTask,
  type RecordManagedCommandCompletionInput,
} from './managed-command-wake-lifecycle.js';

const log = createModuleLogger('ball-custody/retired-managed-command-terminal-recovery');
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
    holdLifecycle: { ...parsed.lifecycle, managedCommand: command },
  });
}

function persistCompletion(
  store: ManagedCommandWakeDynamicTaskStore,
  input: RecordManagedCommandCompletionInput,
  conditionMetAt: number,
): 'missing' | 'active' | 'terminal' | 'contended' {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const parsed = parseRetiredManagedCommandWakeTask(store.getById(input.taskId));
    if (!parsed || parsed.command.state === 'cancelled') return 'missing';
    if (parsed.command.state === 'consumed') return 'terminal';
    if (parsed.command.result) return 'active';
    if (parsed.command.state !== 'command_running' && parsed.command.state !== 'condition_met') return 'missing';
    if (
      updateCommand(store, parsed, {
        ...parsed.command,
        state: 'condition_met',
        conditionMetAt,
        wakeContent: input.wakeContent,
        wakeSource: 'command_completion',
        result: normalizeManagedCommandTerminalResult(input.result),
      })
    ) {
      return 'active';
    }
  }
  return 'contended';
}

function claimMessage(
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
  return parseRetiredManagedCommandWakeTask(store.getById(parsed.task.id));
}

function commitVisibility(
  store: ManagedCommandWakeDynamicTaskStore,
  taskId: string,
  claimGeneration: number | undefined,
  messageId: string,
  now: number,
): boolean {
  if (claimGeneration === undefined) return false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const latest = parseRetiredManagedCommandWakeTask(store.getById(taskId));
    if (
      !latest ||
      latest.command.state !== 'condition_met' ||
      latest.command.messageClaimGeneration !== claimGeneration
    ) {
      return latest?.command.state === 'consumed' && latest.command.messageId === messageId;
    }
    const { messageClaimedAt: _claimedAt, pendingCompletionContent: _pending, ...selected } = latest.command;
    if (
      updateCommand(store, latest, {
        ...selected,
        state: 'consumed',
        messageId,
        messageWrittenAt: latest.command.messageWrittenAt ?? now,
        consumedAt: latest.command.consumedAt ?? now,
      })
    ) {
      return true;
    }
  }
  return false;
}

function releaseClaim(
  store: ManagedCommandWakeDynamicTaskStore,
  taskId: string,
  claimGeneration: number | undefined,
): void {
  if (claimGeneration === undefined) return;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const latest = parseRetiredManagedCommandWakeTask(store.getById(taskId));
    if (
      !latest ||
      latest.command.state !== 'condition_met' ||
      latest.command.messageId ||
      latest.command.messageClaimGeneration !== claimGeneration
    ) {
      return;
    }
    const { messageClaimedAt: _claimedAt, ...released } = latest.command;
    if (updateCommand(store, latest, released)) return;
  }
}

function broadcast(
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

async function publish(
  deps: Pick<ManagedCommandWakeRecoveryDeps, 'dynamicTaskStore' | 'messageStore' | 'socketManager'>,
  parsed: ParsedManagedCommandWakeTask,
  now: () => number,
): Promise<boolean> {
  if (parsed.command.state === 'consumed') return true;
  if (parsed.command.state !== 'condition_met' || !parsed.command.wakeContent) return false;
  const claimed = claimMessage(deps.dynamicTaskStore, parsed, now());
  if (!claimed?.command.wakeContent) return false;
  const idempotencyKey = `${COMPLETION_MESSAGE_KEY_PREFIX}${claimed.task.id}`;
  try {
    const existing = await deps.messageStore.getByIdempotencyKey('scheduler', claimed.threadId, idempotencyKey);
    const stored =
      existing ??
      (await deps.messageStore.append({
        userId: 'scheduler',
        catId: null,
        content: `[定时任务] ${claimed.command.wakeContent}`,
        mentions: [],
        timestamp: now(),
        threadId: claimed.threadId,
        idempotencyKey,
        source: {
          connector: 'hold-ball',
          label: '持球结果',
          icon: '🏓',
          meta: {
            taskId: claimed.task.id,
            threadId: claimed.threadId,
            catId: claimed.catId,
            wakeWhen: true,
            terminalReceipt: true,
          },
        },
      }));
    if (!existing) broadcast(deps.socketManager, claimed.threadId, stored);
    return commitVisibility(
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
        'terminal message outcome is uncertain; retaining the claim for recovery',
      );
      return false;
    }
    if (committedAfterError) {
      return commitVisibility(
        deps.dynamicTaskStore,
        claimed.task.id,
        claimed.command.messageClaimGeneration,
        committedAfterError.id,
        now(),
      );
    }
    releaseClaim(deps.dynamicTaskStore, claimed.task.id, claimed.command.messageClaimGeneration);
    log.warn(
      { err, taskId: claimed.task.id, threadId: claimed.threadId },
      'terminal evidence persisted but timeline visibility is pending',
    );
    return false;
  }
}

export function listRetiredManagedCommandRecoveryTaskIds(tasks: readonly DynamicTaskDef[]): string[] {
  return tasks.flatMap((task) => {
    const parsed = parseRetiredManagedCommandWakeTask(task);
    return parsed?.command.state === 'condition_met' ? [task.id] : [];
  });
}

export async function recoverRetiredManagedCommandTask(
  deps: ManagedCommandWakeRecoveryDeps,
  taskId: string,
  now: () => number,
): Promise<ManagedCommandWakeRecoveryResult> {
  const parsed = parseRetiredManagedCommandWakeTask(deps.dynamicTaskStore.getById(taskId));
  if (!parsed) return 'missing';
  if (parsed.command.state === 'consumed') return 'recovered';
  if (parsed.command.state !== 'condition_met') return 'pending';
  return (await publish(deps, parsed, now)) ? 'recovered' : 'pending';
}

export async function recordRetiredManagedCommandCompletion(
  deps: ManagedCommandWakeRecoveryDeps,
  input: RecordManagedCommandCompletionInput,
  now: () => number,
): Promise<ManagedCommandWakeRecoveryResult> {
  const evidence = persistCompletion(deps.dynamicTaskStore, input, now());
  if (evidence === 'missing') return 'missing';
  if (evidence === 'terminal') return 'recovered';
  if (evidence === 'contended') return 'pending';
  return recoverRetiredManagedCommandTask(deps, input.taskId, now);
}
