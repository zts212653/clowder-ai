import type { CodexAppServerJsonObject } from '../../../cats/services/agents/providers/CodexAppServerEventMapper.js';
import type { LiveReturnProjection, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { LiveCompanionCallOptions } from '../live-call-options.js';
import { recordLiveTranscript } from '../live-transcript.js';

export function recordCallTranscript(input: {
  options: LiveCompanionCallOptions;
  nativeThreadId?: string;
  realtimeSessionId?: string;
  nativeTurnId?: string;
  envelope: CodexAppServerJsonObject;
  exposedMessages: Map<string, { kind: 'text' | 'voice'; digest: string }>;
  onOwnerVoice(message: StoredMessage): void;
  onCommitted?(message: StoredMessage): void | Promise<void>;
  onPublished?(message: StoredMessage): void;
  returnProjection?: LiveReturnProjection;
}): Promise<void> {
  if (!input.nativeThreadId || !input.realtimeSessionId) return Promise.resolve();
  return recordLiveTranscript({
    store: input.options.messageStore,
    binding: {
      ...input.options.binding,
      nativeThreadId: input.nativeThreadId,
      realtimeSessionId: input.realtimeSessionId,
      ...(input.nativeTurnId ? { nativeTurnId: input.nativeTurnId } : {}),
    },
    envelope: input.envelope,
    identity: input.options.identitySnapshot,
    exposedMessages: input.exposedMessages,
    publish: input.options.publish,
    onOwnerVoice: (_id, stored) => input.onOwnerVoice(stored),
    ...(input.onCommitted ? { onCommitted: input.onCommitted } : {}),
    ...(input.onPublished ? { onPublished: input.onPublished } : {}),
    ...(input.returnProjection ? { returnProjection: input.returnProjection } : {}),
  });
}
