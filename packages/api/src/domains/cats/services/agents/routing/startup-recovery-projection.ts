import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { AgentMessage } from '../../types.js';

/** Await the original response writer before the event is broadcast, even without text/tool output. */
export async function persistStartupRecovery(
  store: IMessageStore,
  event: AgentMessage,
  responseMessageId: string | undefined,
  invocationId: string | undefined,
): Promise<boolean> {
  const recovery = event.extra?.startupRecovery;
  if (!recovery) return true;
  if (!responseMessageId || !invocationId || recovery.invocationId !== invocationId) return false;
  const current = await store.getById(responseMessageId);
  if (
    current?.lifecycle?.kind !== 'response' ||
    current.lifecycle.invocationId !== invocationId ||
    current.catId !== event.catId ||
    current.lifecycle.status !== 'processing'
  )
    return false;
  const previous = current.extra?.startupRecovery;
  if (
    previous &&
    (previous.invocationId !== invocationId ||
      previous.sequence >= recovery.sequence ||
      ['ready', 'failed', 'cancelled'].includes(previous.stage))
  )
    return false;
  const updated = await store.updateExtra(responseMessageId, { startupRecovery: recovery });
  return Boolean(updated);
}
