import { createHash } from 'node:crypto';
import type { CatId, CompanionIdentitySnapshotV1 } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';

export interface LiveTranscriptBinding {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: CatId;
  readonly callId: string;
  readonly nativeThreadId: string;
  readonly realtimeSessionId: string;
  readonly nativeTurnId?: string;
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export const liveMessageDigest = (message: { catId: string | null; content: string }): string =>
  createHash('sha256')
    .update(JSON.stringify([message.catId, message.content]))
    .digest('hex');

export async function persistLiveUserText(
  store: Pick<IMessageStore, 'appendIdempotent'>,
  binding: Pick<LiveTranscriptBinding, 'userId' | 'threadId' | 'callId'>,
  text: string,
  clientMessageId: string,
) {
  const stored = await store.appendIdempotent({
    userId: binding.userId,
    threadId: binding.threadId,
    catId: null,
    content: text,
    mentions: [],
    timestamp: Date.now(),
    idempotencyKey: `live-text:${binding.callId}:${clientMessageId}`,
    extra: { liveCompanion: { callId: binding.callId, modality: 'typed', role: 'user', clientMessageId } },
  });
  const source = stored.message.extra?.liveCompanion;
  if (
    stored.message.content !== text ||
    stored.message.catId !== null ||
    source?.modality !== 'typed' ||
    source.callId !== binding.callId ||
    source.clientMessageId !== clientMessageId
  )
    throw new Error('Live text identity conflict');
  return stored;
}

/** Consume only the provider's committed timeline, on the Host-owned wire. Never accept renderer-authored cat text. */
export async function persistLiveTranscriptItem(
  store: Pick<IMessageStore, 'appendIdempotent'>,
  binding: LiveTranscriptBinding,
  envelope: unknown,
  identity?: CompanionIdentitySnapshotV1,
): Promise<StoredMessage | null> {
  const event = record(envelope);
  const params = record(event.params);
  const item = record(params.item);
  if (params.threadId !== binding.nativeThreadId) return null;
  const voice =
    event.method === 'thread/realtime/item/completed' &&
    item.realtimeSessionId === binding.realtimeSessionId &&
    item.type === 'transcriptSegment' &&
    ['user', 'assistant'].includes(String(item.role));
  const resultItem =
    event.method === 'item/completed' &&
    binding.nativeTurnId !== undefined &&
    params.turnId === binding.nativeTurnId &&
    item.type === 'agentMessage' &&
    item.phase === 'final_answer';
  if (!voice && !resultItem) return null;
  if (
    typeof item.id !== 'string' ||
    !/^[A-Za-z0-9_-]{1,160}$/.test(item.id) ||
    typeof item.text !== 'string' ||
    (voice && item.text.length > 32_000)
  )
    throw new Error('Invalid committed Live transcript');
  if (!item.text.trim()) return null;
  if (identity && identity.live.catId !== binding.catId) throw new Error('Live display identity mismatch');
  const catId = voice && item.role === 'user' ? null : binding.catId;
  const result = await store.appendIdempotent({
    userId: binding.userId,
    threadId: binding.threadId,
    catId,
    content: item.text,
    mentions: [],
    timestamp: Date.now(),
    ...(catId ? { origin: 'stream' as const } : {}),
    idempotencyKey: voice
      ? `live:${binding.nativeThreadId}:${binding.realtimeSessionId}:${item.id}`
      : `live-result:${binding.nativeThreadId}:${binding.nativeTurnId}:${item.id}`,
    extra: {
      liveCompanion: {
        callId: binding.callId,
        nativeThreadId: binding.nativeThreadId,
        realtimeSessionId: binding.realtimeSessionId,
        nativeItemId: item.id,
        modality: voice ? 'voice' : 'result',
        role: voice && item.role === 'user' ? 'user' : 'assistant',
        ...(resultItem ? { nativeTurnId: binding.nativeTurnId } : {}),
        ...(identity ? { identity } : {}),
      },
    },
  });
  if (result.message.catId !== catId || result.message.content !== item.text)
    throw new Error('Live transcript identity conflict');
  return result.idempotent ? null : result.message;
}
