import type { SuggestionView } from '@cat-cafe/shared';
import type { SuggestionRecord } from './SuggestionStore.js';
import { toSuggestionView } from './suggestion-projection.js';
import type { SuggestionActor, SuggestionResult, SuggestionServiceDeps } from './suggestion-service-contract.js';
import { attachWatcherSupplement } from './suggestion-supplement.js';

/** Resolve the original message without creating a second row or accepting another conversation's anchor. */
export async function resolveSuggestionAnchor(
  deps: SuggestionServiceDeps,
  actor: SuggestionActor,
  messageId: string | undefined,
): Promise<SuggestionResult<string>> {
  if (messageId) {
    const message = await deps.loadMessage(messageId);
    if (!message || message.userId !== actor.userId || message.threadId !== actor.threadId)
      return { ok: false, code: 'message_not_found', error: 'That message is not in this conversation' };
    return { ok: true, value: messageId };
  }
  const turnMessageId = deps.resolveTurnMessageId?.(actor);
  return turnMessageId
    ? { ok: true, value: turnMessageId }
    : { ok: false, code: 'message_not_found', error: 'No reply in this turn to hang the row under; pass messageId' };
}

/** Admission remains in the original suggestion store, atomically fenced against a changed watcher control. */
export async function insertSuggestion(
  deps: SuggestionServiceDeps,
  record: SuggestionRecord,
  now: () => number,
  publish: (record: SuggestionRecord) => void,
  supplement = false,
  guardActor?: SuggestionActor,
): Promise<SuggestionResult<SuggestionView>> {
  const fence = guardActor?.byline === 'watcher' ? await deps.watcherOutputFence?.(guardActor) : undefined;
  if (fence === null) return { ok: false, code: 'conflict', error: '守望猫已暂停，提议没有提交' };
  const created = await deps.store.create(record, record.receiptOnly ? undefined : 'offered', fence).catch((error) => {
    if (error instanceof Error && error.message.includes('watcher_output_control_changed')) return null;
    throw error;
  });
  if (!created) return { ok: false, code: 'conflict', error: '守望设置已改变，提议没有提交' };
  if (created.kind === 'message_taken') {
    if (supplement) return attachWatcherSupplement(deps.store, created.existingId, record, now, publish);
    return {
      ok: false,
      code: 'message_taken',
      error: 'That message already carries a suggestion or receipt; one row per message',
    };
  }
  publish(record);
  return { ok: true, value: toSuggestionView(record) };
}
