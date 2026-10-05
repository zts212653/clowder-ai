import type { FreshnessReadableMessage } from '../../cats/services/freshness/checkFreshnessForPostMessage.js';
import { liveMessageDigest } from './live-transcript.js';

interface ExposureScope {
  stopRequested: boolean;
  userId: string;
  threadId: string;
  callId: string;
  nativeThreadId: string | undefined;
  realtimeSessionId: string | undefined;
}

/** A same-call receipt is evidence of exposure only while its exact source still matches. */
export function liveExposureReason(
  message: FreshnessReadableMessage,
  scope: ExposureScope,
  receipt?: { kind: 'text' | 'voice'; digest: string },
): 'same_live_call_exposure' | null {
  if (
    scope.stopRequested ||
    message.userId !== scope.userId ||
    message.threadId !== scope.threadId ||
    !receipt ||
    receipt.digest !== liveMessageDigest(message)
  )
    return null;
  if (receipt.kind === 'text') return 'same_live_call_exposure';
  const item = message.extra?.liveCompanion;
  return item &&
    item.modality === 'voice' &&
    scope.realtimeSessionId &&
    item.callId === scope.callId &&
    item.nativeThreadId === scope.nativeThreadId &&
    item.realtimeSessionId === scope.realtimeSessionId &&
    item.nativeItemId
    ? 'same_live_call_exposure'
    : null;
}

export function liveCallExposureReason(
  message: FreshnessReadableMessage,
  binding: Pick<ExposureScope, 'userId' | 'threadId' | 'callId'>,
  state: Pick<ExposureScope, 'stopRequested' | 'nativeThreadId' | 'realtimeSessionId'>,
  receipt?: { kind: 'text' | 'voice'; digest: string },
): 'same_live_call_exposure' | null {
  return liveExposureReason(message, { ...binding, ...state }, receipt);
}
