import { createCatId } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type {
  ProviderNativeRealtimeConsumer,
  ProviderNativeRealtimeEvent,
  ProviderNativeRealtimeSession,
} from '../domains/cats/services/types.js';
import type { RealtimeCompanionAudioSubscription } from './realtime-companion-audio-source.js';

export interface ActiveCompanion {
  readonly key: string;
  readonly idempotencyScope: string;
  readonly threadId: string;
  readonly userId: string;
  readonly catId: string;
  readonly consumer: ProviderNativeRealtimeConsumer;
  readonly startedAt: number;
  readonly provider: ProviderNativeRealtimeSession;
  audio?: RealtimeCompanionAudioSubscription;
  outputOrdinal: number;
  stopping?: boolean;
  stopPromise?: Promise<void>;
}

export async function consumeRealtimeCompanionEvent(
  dependencies: {
    readonly messageStore: Pick<IMessageStore, 'append'>;
    readonly publishMessage?: (threadId: string, message: StoredMessage) => void;
  },
  active: Map<string, ActiveCompanion>,
  session: ActiveCompanion,
  event: ProviderNativeRealtimeEvent,
): Promise<void> {
  if (event.kind === 'closed') {
    void stopRealtimeCompanion(active, session, false);
    return;
  }
  if (event.kind === 'error') {
    void stopRealtimeCompanion(active, session, true);
    return;
  }
  if (event.kind !== 'assistant_transcript' || session.stopping || active.get(session.key) !== session) return;
  session.outputOrdinal += 1;
  const stored = await dependencies.messageStore.append({
    userId: session.userId,
    threadId: session.threadId,
    catId: createCatId(session.catId),
    content: event.text,
    mentions: [],
    timestamp: event.occurredAt,
    origin: 'stream',
    idempotencyKey: `realtime:${session.idempotencyScope}:${session.outputOrdinal}`,
    extra: {
      realtimeCompanion: {
        consumer: session.consumer,
        invocationId: session.idempotencyScope,
      },
    },
  });
  dependencies.publishMessage?.(session.threadId, stored);
}

export async function stopRealtimeCompanion(
  active: Map<string, ActiveCompanion>,
  session: ActiveCompanion,
  stopProvider: boolean,
): Promise<void> {
  session.stopPromise ??= (async () => {
    session.stopping = true;
    session.audio?.close();
    if (stopProvider) await session.provider.stop().catch(() => {});
    if (active.get(session.key) === session) active.delete(session.key);
  })();
  return session.stopPromise;
}

export function realtimeCompanionSessionKey(input: {
  readonly userId: string;
  readonly thread: { readonly id: string };
  readonly catId: string;
}): string {
  return JSON.stringify([input.userId, input.thread.id, input.catId]);
}

export function projectActiveRealtimeCompanion(session: ActiveCompanion) {
  return {
    status: 'active' as const,
    catId: session.catId,
    consumer: session.consumer,
    startedAt: session.startedAt,
    runtimeSessionId: session.provider.runtimeSessionId,
    realtimeSessionId: session.provider.realtimeSessionId,
    version: session.provider.version,
  };
}
