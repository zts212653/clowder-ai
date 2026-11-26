import { createCatId, WATCHER_PANEL_LABELS, type WatcherPanelRound } from '@cat-cafe/shared';
import {
  type InvocationQueue,
  QueueAdmissionTargetUnavailableError,
} from '../../../cats/services/agents/invocation/InvocationQueue.js';
import type { OwnerAuthProvenance } from '../../../cats/services/agents/invocation/owner-auth-provenance.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';

export const WATCHER_PANEL_SERVICE = 'watcher-panel';
export const WATCHER_PANEL_SPEAKER = '守望猫';

/** The delivered message names no member; only the owner ledger maps labels to cats. */
export function isWatcherPanelDelivery(message: Pick<StoredMessage, 'from' | 'source'> | null | undefined): boolean {
  return (
    message?.from?.kind === 'system' &&
    message.from.service === WATCHER_PANEL_SERVICE &&
    message.source?.connector === WATCHER_PANEL_SERVICE
  );
}

export function watcherPanelDeliveryContent(round: WatcherPanelRound): string | null {
  const spoke = round.members
    .filter((member) => member.status === 'spoke' && member.sentence)
    .sort((left, right) => WATCHER_PANEL_LABELS.indexOf(left.label) - WATCHER_PANEL_LABELS.indexOf(right.label));
  if (spoke.length === 0) return null;
  const items = spoke.map((member) => {
    const cite = member.citationMessageId
      ? `\n（依据：[原话](/thread/${round.threadId}?message=${member.citationMessageId})）`
      : '';
    return `**${member.label}**：${member.sentence}${cite}`;
  });
  return `@${round.workerCatId}\n\n守望猫看了刚结束的这一轮，有 ${spoke.length} 句：\n\n${items.join('\n\n')}`;
}

export async function deliverWatcherPanelRound(
  owners: {
    messages: IMessageStore;
    queue: Pick<InvocationQueue, 'enqueueExistingMessageDurable'>;
    publish(message: StoredMessage): void;
  },
  round: WatcherPanelRound,
  ownerAuthProvenance: OwnerAuthProvenance,
): Promise<NonNullable<WatcherPanelRound['delivery']>> {
  const content = watcherPanelDeliveryContent(round);
  if (!content) return { skipped: 'nobody_spoke' };
  const key = `watcher-panel:${round.roundId}`;
  const from = { kind: 'system' as const, service: WATCHER_PANEL_SERVICE };
  const message =
    (await owners.messages.getByIdempotencyKey(round.userId, round.threadId, key)) ??
    (await owners.messages.append({
      from,
      userId: round.userId,
      threadId: round.threadId,
      content,
      mentions: [createCatId(round.workerCatId)],
      timestamp: Date.now(),
      idempotencyKey: key,
      source: {
        connector: WATCHER_PANEL_SERVICE,
        label: WATCHER_PANEL_SPEAKER,
        icon: 'watcher',
        meta: {
          roundId: round.roundId,
          labels: round.members.filter((member) => member.status === 'spoke').map((member) => member.label),
        },
      },
      extra: { targetCats: [createCatId(round.workerCatId)] },
    }));
  try {
    await owners.queue.enqueueExistingMessageDurable(owners.messages, message.id, {
      threadId: round.threadId,
      userId: round.userId,
      kind: 'message_wake',
      ownerAuthProvenance,
      from,
      content: message.content,
      targetCats: [createCatId(round.workerCatId)],
      intent: 'execute',
      autoExecute: true,
      exactTargets: true,
    });
  } catch (error) {
    if (!(error instanceof QueueAdmissionTargetUnavailableError)) throw error;
    return { skipped: 'target_unavailable' };
  }
  owners.publish(message);
  return { messageId: message.id, targetCatId: round.workerCatId, deliveredAt: Date.now() };
}
