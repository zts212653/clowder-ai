import type { StoredMessage } from '../../../../cats/services/stores/ports/MessageStore.js';
import { isOwnerVoiceSource, type OwnerVoiceMessageStore, type OwnerVoiceNotice } from './live-owner-voice-source.js';

export interface OwnerVoicePayload {
  readonly text: string;
  readonly messages: readonly StoredMessage[];
}

function voiceMetadata(message: StoredMessage) {
  const metadata = message.extra?.liveCompanion;
  return metadata?.modality === 'voice' ? metadata : undefined;
}

/** Native transcriptSegment completion can split a single utterance, including its negation. */
export async function readOwnerVoicePayload(
  store: OwnerVoiceMessageStore,
  notice: OwnerVoiceNotice,
  exposed: (message: StoredMessage) => boolean,
): Promise<OwnerVoicePayload | null> {
  if (!notice.utterance) return { text: notice.message.content, messages: [notice.message] };
  const { itemIds, text } = notice.utterance;
  if (!text?.trim() || text.length > 8_000 || itemIds.length < 1 || itemIds.length > 32) return null;
  if (new Set(itemIds).size !== itemIds.length) return null;
  const latest = voiceMetadata(notice.message);
  if (!latest || itemIds.at(-1) !== latest.nativeItemId) return null;
  const messages = await committedUtteranceMessages(store, notice, exposed);
  if (!messages || messages.at(-1)?.id !== notice.message.id) return null;
  // Only whitespace is normalized for this comparison; words and punctuation are never repaired.
  const joined = messages.map((message) => message.content).join('');
  const withoutWhitespace = (value: string) => value.replace(/\s/gu, '');
  if (joined.length > 8_000 || withoutWhitespace(joined) !== withoutWhitespace(text)) {
    console.warn('[live-owner-voice] utterance source mismatch', {
      partCount: messages.length,
      committedLength: joined.length,
      completedLength: text.length,
    });
    return null;
  }
  return { text: joined, messages };
}

async function committedUtteranceMessages(
  store: OwnerVoiceMessageStore,
  notice: OwnerVoiceNotice,
  exposed: (message: StoredMessage) => boolean,
): Promise<StoredMessage[] | null> {
  const messages: StoredMessage[] = [];
  for (const id of notice.utterance?.itemIds ?? []) {
    const messageId = notice.utterance?.messageIds.get(id);
    if (!messageId) return null;
    const message = await store.getById(messageId);
    if (
      !message ||
      voiceMetadata(message)?.nativeItemId !== id ||
      !isOwnerVoiceSource(message, notice.scope, exposed) ||
      voiceMetadata(message)?.realtimeSessionId !== voiceMetadata(notice.message)?.realtimeSessionId
    )
      return null;
    messages.push({ ...message });
  }
  return messages;
}

/** Every part is re-read at the final native write, not just the newest segment. */
export async function ownerVoicePayloadIsCurrent(
  store: OwnerVoiceMessageStore,
  notice: OwnerVoiceNotice,
  payload: OwnerVoicePayload,
  exposed: (message: StoredMessage) => boolean,
): Promise<boolean> {
  for (const saved of payload.messages) {
    const current = await store.getById(saved.id);
    if (
      !current ||
      current.content !== saved.content ||
      current.deliveryStatus === 'queued' ||
      current.recall !== undefined ||
      !isOwnerVoiceSource(current, notice.scope, exposed) ||
      voiceMetadata(current)?.nativeItemId !== voiceMetadata(saved)?.nativeItemId ||
      voiceMetadata(current)?.realtimeSessionId !== voiceMetadata(saved)?.realtimeSessionId
    )
      return false;
  }
  return true;
}
