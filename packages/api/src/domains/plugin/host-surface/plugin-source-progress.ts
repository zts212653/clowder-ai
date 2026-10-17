import type { InvocationQueue } from '../../cats/services/agents/invocation/InvocationQueue.js';
import { queueEntryId } from '../../cats/services/agents/invocation/queue-ledger/QueueLedger.js';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { ExternalPluginRuntimeError } from '../external-runtime/types.js';
import type { PluginSourceFact } from './plugin-source-facts-host.js';

export interface PluginQueueProgress {
  readonly status: 'queued' | 'processing' | 'terminal';
  readonly allTargetCats: readonly string[];
  readonly handledByCatIds: readonly string[];
  readonly failedByCatIds: readonly string[];
  readonly seenByCatIds: readonly string[];
  readonly bodyExposures?: readonly { readonly targetCatId: string }[];
  readonly targetOutcomeByCatId?: Readonly<Record<string, { readonly handledAt: number }>>;
}
/** Existing SDK display shape; QueueLedger and History remain the only storage owners. */
export type PluginSourceProgressFact = Omit<PluginSourceFact, 'content'> & {
  readonly queueCustody?: PluginQueueProgress;
};
export async function projectPluginQueueProgress(
  message: StoredMessage,
  userId: string,
  messages: Pick<IMessageStore, 'getById'>,
  queue?: Pick<InvocationQueue, 'getDurableEntry'>,
): Promise<PluginQueueProgress | undefined> {
  function refuse(): never {
    throw new ExternalPluginRuntimeError('DELIVERY_REJECTED', 'Plugin source progress is unavailable');
  }
  if (message.userId !== userId) refuse();
  const entryId = queueEntryId(message.id);
  const row = await queue?.getDurableEntry(message.threadId, entryId);
  if (row && (row.owner.kind !== 'user' || row.owner.userId !== userId || row.payload.messageId !== message.id))
    refuse();
  const refs = message.lifecycle?.dispatchRefs ?? [];
  if (!row && refs.length === 0) return undefined;
  const handled: string[] = [],
    failed: string[] = [],
    seen: string[] = [];
  const outcomes: Record<string, { handledAt: number }> = {};
  let processing = false;
  for (const ref of refs) {
    const response = await messages.getById(ref.statusMessageId);
    const lifecycle = response?.lifecycle;
    if (!response || response.userId !== userId || response.threadId !== message.threadId) refuse();
    if (lifecycle?.kind === 'delivery_failure') {
      if (lifecycle.inputMessageId !== message.id || lifecycle.sourceEntryId !== entryId) refuse();
      failed.push(ref.targetId);
      continue;
    }
    if (
      lifecycle?.kind !== 'response' ||
      lifecycle.targetId !== ref.targetId ||
      !lifecycle.inputMessageIds.includes(message.id) ||
      !lifecycle.inputEntryIds.includes(entryId)
    )
      refuse();
    if (ref.inputRead?.status === 'read') seen.push(ref.targetId);
    if (lifecycle.status === 'processing') processing = true;
    else if (lifecycle.status === 'completed') {
      handled.push(ref.targetId);
      if (lifecycle.completedAt !== undefined) outcomes[ref.targetId] = { handledAt: lifecycle.completedAt };
    } else failed.push(ref.targetId);
  }
  return {
    status: processing ? 'processing' : row ? 'queued' : 'terminal',
    allTargetCats: [...new Set([...(row?.targets ?? []), ...refs.map((ref) => ref.targetId)])],
    handledByCatIds: handled,
    failedByCatIds: failed,
    seenByCatIds: seen,
    bodyExposures: seen.map((targetCatId) => ({ targetCatId })),
    targetOutcomeByCatId: outcomes,
  };
}
