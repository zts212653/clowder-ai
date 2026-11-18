import { createCatId, type TurnExecutionRecord, WATCHER_PANEL_LABELS } from '@cat-cafe/shared';
import { isHomeSession } from '../../../cats/services/session/session-scope.js';
import { isDisplayOnlySystemMessage } from '../../../cats/services/stores/host-message-policy.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ISessionChainStore } from '../../../cats/services/stores/ports/SessionChainStore.js';
import type { ITurnExecutionStore } from '../../../cats/services/stores/ports/TurnExecutionStore.js';
import { watcherMessageTime } from './watcher-panel-context.js';
import { isWatcherPanelDelivery } from './watcher-panel-delivery.js';
import type { WatcherPanelLedger } from './watcher-panel-ledger.js';
import { reconcileWatcherPanelRound } from './watcher-panel-outcomes.js';

/** The judged turn's reply, or the last cat-readable message at its settlement. An anchor, not the lock. */
export async function watcherPanelCutoffMessage(
  messages: IMessageStore,
  source: TurnExecutionRecord,
): Promise<StoredMessage | null> {
  const settlement = source.responseSettlement;
  if (!settlement) return null;
  if (settlement.kind === 'message') {
    const reply = await messages.getById(settlement.messageId);
    if (reply && reply.threadId === source.threadId) return reply;
  }
  const rows = await messages.getByThreadBefore(
    source.threadId,
    settlement.settledAt + 1,
    10,
    undefined,
    source.userId,
  );
  return [...rows].reverse().find((row) => row.visibility !== 'whisper' && !isDisplayOnlySystemMessage(row)) ?? null;
}

/** A turn started by a watcher's words: the panel looks but does not answer it with another wake. */
export async function wokenByWatcher(messages: IMessageStore, source: TurnExecutionRecord): Promise<boolean> {
  const triggerId = source.causal?.triggerMessageId;
  if (!triggerId) return false;
  const trigger = await messages.getById(triggerId);
  return isWatcherPanelDelivery(trigger) || trigger?.extra?.watcher?.kind === 'nudge';
}

/** The member's last completed look (ledger) and every reply that settled after it, up to this turn. */
export async function watcherPanelPrevious(
  deps: { ledger: WatcherPanelLedger; executions: Pick<ITurnExecutionStore, 'listSettled' | 'get'> },
  source: TurnExecutionRecord,
  catId: string,
  roundId: string,
) {
  for (const round of await deps.ledger.list({ userId: source.userId, threadId: source.threadId, limit: 50 })) {
    if (round.roundId === roundId) continue;
    const reconciled = await reconcileWatcherPanelRound(deps.executions, {
      ...round,
      members: round.members.filter((member) => member.catId === catId),
    });
    const entry = reconciled.members.find(
      (member) =>
        member.catId === catId &&
        member.executionStatus === 'succeeded' &&
        (member.status === 'spoke' || member.status === 'quiet'),
    );
    if (!entry?.sessionId) continue;
    if (round.cutoffAt === undefined) return undefined;
    const settled = await deps.executions.listSettled({
      userId: source.userId,
      threadId: source.threadId,
      afterSequence: round.sourceSettledSequence,
      limit: 200,
    });
    const settledReplyIds = settled.records
      .filter((record) => record.settledSequence! <= source.settledSequence!)
      .flatMap((record) =>
        record.responseSettlement?.kind === 'message' ? [record.responseSettlement.messageId] : [],
      );
    return { cutoffAt: round.cutoffAt, settledReplyIds, sessionId: entry.sessionId };
  }
  return undefined;
}

/** A member that also works here through its own session is not an independent eye; the ledger says so. */
export async function watcherPanelAlsoWorksHere(
  sessions: Pick<ISessionChainStore, 'getChain'>,
  source: TurnExecutionRecord,
  catId: string,
): Promise<'worker' | 'participant' | undefined> {
  if (catId === source.catId) return 'worker';
  const chain = await sessions.getChain(createCatId(catId), source.threadId, source.userId);
  return chain.some(isHomeSession) ? 'participant' : undefined;
}

/** A fresh random order every round, so a label's position never names a member. */
export function shuffledWatcherPanelLabels(count: number, random: () => number = Math.random) {
  const labels = [...WATCHER_PANEL_LABELS.slice(0, count)];
  for (let index = labels.length - 1; index > 0; index--) {
    const pick = Math.floor(random() * (index + 1));
    [labels[index], labels[pick]] = [labels[pick]!, labels[index]!];
  }
  return labels;
}

/** A citation must be an original of this thread that existed by the round's lock. */
export async function watcherPanelCitationValid(
  messages: IMessageStore,
  threadId: string,
  cutoffAt: number,
  messageId: string,
): Promise<boolean> {
  const cited = await messages.getById(messageId);
  return Boolean(
    cited && cited.threadId === threadId && !cited.deletedAt && !cited.recall && watcherMessageTime(cited) <= cutoffAt,
  );
}
