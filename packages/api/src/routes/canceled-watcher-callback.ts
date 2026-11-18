import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';

function callbackAuthMeta(message: StoredMessage) {
  if (
    message.from?.kind !== 'system' ||
    message.from.service !== 'callback-auth' ||
    message.source?.connector !== 'callback-auth' ||
    message.extra?.rich?.blocks?.length !== 1
  )
    return undefined;
  const block = message.extra.rich.blocks[0];
  return block?.kind === 'card' && block.meta?.kind === 'callback_auth_failure' ? block.meta : undefined;
}

/** Cats never receive private panel diagnostics. The owner retains the original audit card. */
export async function isCatHiddenWatcherCallbackCard(
  message: StoredMessage,
  executions: Pick<ITurnExecutionStore, 'get'> | undefined,
): Promise<boolean> {
  const meta = callbackAuthMeta(message);
  if (!meta) return false;
  // An unknown diagnostic identity cannot safely prove that a member name is public.
  if (!executions || typeof meta.invocationId !== 'string') return true;
  try {
    const turn = await executions.get(meta.invocationId);
    if (
      !turn ||
      turn.invocationId !== meta.invocationId ||
      turn.userId !== message.userId ||
      turn.threadId !== message.threadId ||
      turn.userId !== meta.userId ||
      turn.threadId !== meta.threadId ||
      turn.catId !== meta.catId
    )
      return true;
    return (
      turn.executionKind === 'watcher' &&
      Boolean(turn.causal?.watcherPanelRoundId || (turn.status === 'canceled' && meta.reason === 'canceled'))
    );
  } catch {
    return true;
  }
}

/** Old canceled-observer error cards remain audit evidence, not a retryable browser task. */
export async function isCanceledWatcherCallbackCard(
  message: StoredMessage,
  executions: Pick<ITurnExecutionStore, 'get'> | undefined,
): Promise<boolean> {
  if (
    !executions ||
    message.from?.kind !== 'system' ||
    message.from.service !== 'callback-auth' ||
    message.source?.connector !== 'callback-auth'
  )
    return false;
  const blocks = message.extra?.rich?.blocks;
  if (blocks?.length !== 1) return false;
  const block = blocks[0];
  if (block?.kind !== 'card') return false;
  const meta = block.meta;
  if (meta?.kind !== 'callback_auth_failure' || meta.reason !== 'canceled' || typeof meta.invocationId !== 'string')
    return false;
  // This is an optional read projection. If its truth source is unavailable,
  // retain the original card rather than hiding evidence or breaking history.
  let turn: Awaited<ReturnType<ITurnExecutionStore['get']>>;
  try {
    turn = await executions.get(meta.invocationId);
  } catch {
    return false;
  }
  return Boolean(
    turn &&
      turn.invocationId === meta.invocationId &&
      turn.executionKind === 'watcher' &&
      turn.status === 'canceled' &&
      turn.userId === message.userId &&
      turn.userId === meta.userId &&
      turn.threadId === message.threadId &&
      turn.threadId === meta.threadId &&
      turn.catId === meta.catId,
  );
}
