import {
  type CollectiveComposerRichEditor,
  type CollectiveComposerVoiceDraft,
  type CollectiveMessageAttachment,
  type CollectiveMessageQuote,
  type CollectiveMessageRichBlock,
  collectiveComposerRichEditorSchema,
  collectiveComposerVoiceDraftSchema,
  collectiveMessageAttachmentSchema,
  collectiveMessageQuoteSchema,
  collectiveMessageRichBlockSchema,
  collectiveRecipientSchema,
} from '@cat-cafe/shared';
import type { CollectiveEventEnvelope, CollectiveParticipant, CollectiveRecipient } from './client-types.js';
import { mentionSelectionForEvent } from './participant-identity.js';
import {
  readSharedArtifactDraftSelections,
  type SharedArtifactDraftReply,
  type SharedArtifactDraftRework,
  type SharedArtifactDraftSelection,
  sharedArtifactDraftReplySchema,
  sharedArtifactDraftReworkSchema,
} from './shared-artifact-draft.js';

export interface ComposerDraft {
  readonly voiceDraft?: CollectiveComposerVoiceDraft;
  readonly richEditor?: CollectiveComposerRichEditor;
  readonly richBlocks?: readonly CollectiveMessageRichBlock[];
  readonly attachments?: readonly CollectiveMessageAttachment[];
  readonly contextAttachments?: readonly CollectiveMessageQuote[];
  readonly body: string;
  readonly entrust?: boolean;
  readonly responseRequested?: boolean;
  readonly recipient: CollectiveRecipient;
  readonly recipientLabel: string;
  readonly replyToEventId?: string;
  readonly replyNeedsSelection?: boolean;
  readonly artifactSelections?: readonly SharedArtifactDraftSelection[];
  readonly artifactRework?: SharedArtifactDraftRework;
  readonly artifactReply?: SharedArtifactDraftReply;
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
    artifactReply: undefined,
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
      voiceDraft: collectiveComposerVoiceDraftSchema.safeParse('voiceDraft' in data ? data.voiceDraft : undefined).data,
      richEditor: collectiveComposerRichEditorSchema.safeParse('richEditor' in data ? data.richEditor : undefined).data,
      richBlocks: collectiveMessageRichBlockSchema.array().safeParse('richBlocks' in data ? data.richBlocks : undefined)
        .data,
      attachments: collectiveMessageAttachmentSchema
        .array()
        .safeParse('attachments' in data ? data.attachments : undefined).data,
      contextAttachments: collectiveMessageQuoteSchema
        .array()
        .safeParse('contextAttachments' in data ? data.contextAttachments : undefined).data,
      body: data.body,
      artifactReply: sharedArtifactDraftReplySchema.safeParse('artifactReply' in data ? data.artifactReply : undefined)
        .data,
      artifactRework: sharedArtifactDraftReworkSchema.safeParse(
        'artifactRework' in data ? data.artifactRework : undefined,
      ).data,
      artifactSelections: readSharedArtifactDraftSelections(
        'artifactSelections' in data ? data.artifactSelections : undefined,
      ),
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

/** An older send acknowledgement cannot erase a newer draft or attachment in the same Topic. */
export function clearConfirmedComposerDraft(current: ComposerDraft, draft: ComposerDraft): ComposerDraft {
  if (
    current.body !== draft.body ||
    current.recipient !== draft.recipient ||
    current.replyToEventId !== draft.replyToEventId ||
    current.attachments !== draft.attachments ||
    current.contextAttachments !== draft.contextAttachments ||
    current.voiceDraft !== draft.voiceDraft ||
    current.richBlocks !== draft.richBlocks ||
    current.richEditor !== draft.richEditor ||
    (current.artifactReply && current.artifactReply !== draft.artifactReply) ||
    (current.artifactRework && current.artifactRework !== draft.artifactRework) ||
    (current.artifactSelections && current.artifactSelections !== draft.artifactSelections)
  )
    return current;
  return current.replyToEventId
    ? {
        ...current,
        body: '',
        attachments: undefined,
        contextAttachments: undefined,
        richBlocks: undefined,
        richEditor: undefined,
        voiceDraft: undefined,
        artifactSelections: undefined,
        artifactRework: undefined,
        artifactReply: undefined,
      }
    : emptyDraft;
}
