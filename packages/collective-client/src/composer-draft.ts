import { collectiveRecipientSchema } from '@cat-cafe/shared';
import type { CollectiveEventEnvelope, CollectiveParticipant, CollectiveRecipient } from './client-types.js';
import { mentionSelectionForEvent } from './participant-identity.js';

export interface ComposerDraft {
  readonly body: string;
  readonly entrust?: boolean;
  readonly responseRequested?: boolean;
  readonly recipient: CollectiveRecipient;
  readonly recipientLabel: string;
  readonly replyToEventId?: string;
  readonly replyNeedsSelection?: boolean;
}
export interface ReplySelection {
  readonly eventId: string;
  readonly selection?: { readonly recipient: CollectiveRecipient; readonly label: string };
  readonly error?: string;
}
export const emptyDraft: ComposerDraft = { body: '', recipient: { kind: 'channel' }, recipientLabel: '' };

export function selectReply(draft: ComposerDraft, reply: ReplySelection): ComposerDraft {
  return {
    ...draft,
    recipient: reply.selection?.recipient ?? { kind: 'channel' },
    recipientLabel: reply.selection?.label ?? '',
    replyToEventId: reply.eventId,
    replyNeedsSelection: Boolean(reply.error),
  };
}

export function readDraft(key: string): ComposerDraft {
  try {
    const data: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null');
    if (!data || typeof data !== 'object' || !('body' in data) || typeof data.body !== 'string') return emptyDraft;
    const parsed = collectiveRecipientSchema.safeParse('recipient' in data ? data.recipient : undefined);
    const recipient = parsed.success ? parsed.data : { kind: 'channel' as const };
    return {
      body: data.body,
      entrust: 'entrust' in data && data.entrust === true,
      responseRequested: recipient.kind === 'channel' && 'responseRequested' in data && data.responseRequested === true,
      recipient,
      recipientLabel: 'recipientLabel' in data && typeof data.recipientLabel === 'string' ? data.recipientLabel : '',
      replyToEventId:
        'replyToEventId' in data && typeof data.replyToEventId === 'string' ? data.replyToEventId : undefined,
      replyNeedsSelection:
        (!parsed.success && 'replyToEventId' in data) ||
        ('replyNeedsSelection' in data && data.replyNeedsSelection === true) ||
        ('replyError' in data && typeof data.replyError === 'string'),
    };
  } catch {
    return emptyDraft;
  }
}

export function replyDraftError(
  draft: ComposerDraft,
  events: readonly CollectiveEventEnvelope[] | undefined,
  participants: readonly CollectiveParticipant[],
  channelId: string,
) {
  const reselect = '请重新选择回复成员；草稿已保留。';
  if (!draft.replyToEventId) return draft.replyNeedsSelection ? reselect : undefined;
  const event = events?.find((item) => item.eventId === draft.replyToEventId);
  if (!event) return '正在回复的消息当前不可用，请重新选择回复消息；草稿已保留。';
  if (draft.replyNeedsSelection) return mentionSelectionForEvent(event, participants, channelId).error ?? reselect;
}
