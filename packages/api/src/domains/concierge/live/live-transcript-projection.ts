import { z } from 'zod';
import type { StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import { clipLiveText } from './live-text-budget.js';

const sourceBase = { callId: z.string().min(1).max(256) };
const nativeId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const persistedSource = z.discriminatedUnion('modality', [
  z.object({
    ...sourceBase,
    modality: z.literal('typed'),
    role: z.literal('user'),
    clientMessageId: z.string().min(1).max(256),
  }),
  z.object({
    ...sourceBase,
    modality: z.literal('voice'),
    role: z.enum(['user', 'assistant']),
    nativeThreadId: z.string().min(1).max(256),
    realtimeSessionId: z.string().min(1).max(256),
    nativeItemId: nativeId,
    nativeTurnId: nativeId.optional(),
  }),
]);
type Source = z.infer<typeof persistedSource>;
type ProjectSource<T extends Source> = T extends Source
  ? { kind: T['modality'] } & Omit<T, 'modality' | 'role'>
  : never;
export interface LiveTranscriptMessage {
  id: string;
  text: string;
  role: 'user' | 'assistant';
  source: ProjectSource<Source>;
  truncated: boolean;
}

export function projectLiveTranscript(
  rows: readonly StoredMessage[],
  scope: { userId: string; threadId: string; callId: string },
  scanHasMore = false,
) {
  const sourced: LiveTranscriptMessage[] = [];
  for (const row of rows) {
    if (
      row.userId !== scope.userId ||
      row.threadId !== scope.threadId ||
      row.deletedAt ||
      row._tombstone ||
      row.recall ||
      !row.content.trim()
    )
      continue;
    const parsed = persistedSource.safeParse(row.extra?.liveCompanion);
    if (!parsed.success || parsed.data.callId !== scope.callId) continue;
    const { role } = parsed.data;
    if ((role === 'user' && row.catId !== null) || (role === 'assistant' && row.catId === null)) continue;
    const source =
      parsed.data.modality === 'typed'
        ? { kind: 'typed' as const, callId: parsed.data.callId, clientMessageId: parsed.data.clientMessageId }
        : {
            kind: 'voice' as const,
            callId: parsed.data.callId,
            nativeThreadId: parsed.data.nativeThreadId,
            realtimeSessionId: parsed.data.realtimeSessionId,
            nativeItemId: parsed.data.nativeItemId,
            ...(parsed.data.nativeTurnId ? { nativeTurnId: parsed.data.nativeTurnId } : {}),
          };
    sourced.push({ id: row.id, role, text: row.content, source, truncated: false });
  }
  const messages: LiveTranscriptMessage[] = [];
  let remaining = 24000;
  let hasMore = scanHasMore;
  // Retain MessageStore order, never invent speech pairs or a cross-source clock.
  for (const row of sourced.slice(-32).reverse()) {
    if (remaining === 0) {
      hasMore = true;
      break;
    }
    const text = clipLiveText(row.text, Math.min(16000, remaining));
    if (!text) {
      hasMore = true;
      continue;
    }
    remaining -= text.length;
    const truncated = text.length !== row.text.length;
    hasMore ||= truncated;
    messages.unshift({ ...row, text, truncated });
  }
  hasMore ||= messages.length < sourced.length;
  return { callId: scope.callId, messages, hasMore };
}
