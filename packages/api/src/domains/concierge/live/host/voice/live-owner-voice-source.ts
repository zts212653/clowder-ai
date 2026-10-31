import type { StoredMessage } from '../../../../cats/services/stores/ports/MessageStore.js';
import type { LiveContextGate, LiveContextScope } from '../live-controlled-context.js';
import type { OwnerCurrentnessStore } from './live-owner-currentness.js';

export { isLatestOwnerMessage } from './live-owner-currentness.js';

export interface OwnerVoiceNotice {
  message: StoredMessage;
  scope: LiveContextScope;
  epoch: number;
  nativeTurnId: string;
  utterance?: { itemIds: string[]; messageIds: Map<string, string>; text?: string };
}

export type OwnerVoiceMessageStore = OwnerCurrentnessStore;

export function ownerVoiceScope(
  context: LiveContextGate,
  invocationId: string | undefined,
  binding: Pick<LiveContextScope, 'catId' | 'threadId'>,
): LiveContextScope | null {
  return invocationId ? context.scope({ ...binding, invocationId }) : null;
}

export function isOwnerVoiceSource(
  message: StoredMessage,
  scope: LiveContextScope,
  exposed: (message: StoredMessage) => boolean,
): boolean {
  return (
    message.userId === scope.userId &&
    message.threadId === scope.threadId &&
    message.catId === null &&
    message.extra?.liveCompanion?.modality === 'voice' &&
    message.extra.liveCompanion.role === 'user' &&
    message.extra.liveCompanion.callId === scope.callId &&
    message.content.trim().length > 0 &&
    message.content.length <= 8_000 &&
    exposed(message)
  );
}
