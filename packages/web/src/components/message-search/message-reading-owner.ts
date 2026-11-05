import type { MessageSearchResponse } from '@cat-cafe/shared';
import type { ChatReadingPort } from '../thread-chat/useThreadChatReadingPort';
import type { MessageFindContext } from './message-find-state';
import { startMessageReadingSession } from './message-reading-session';
import { beginMessageReadingTrip, type MessageReadingEffect } from './message-reading-trip';

export function targetThread(effect: MessageReadingEffect): string {
  return effect.kind === 'target' ? effect.target.threadId : effect.origin.threadId;
}

/** Both message trips and destination returns use the original reader's receipts. */
export async function readThroughOwner(port: ChatReadingPort, effect: MessageReadingEffect, signal: AbortSignal) {
  if (effect.kind === 'target') {
    const receipt = await port.navigateToMessage(effect.target.messageId, signal, { refresh: true });
    if (receipt.status !== 'settled') return receipt.status;
    return receipt.threadId === effect.target.threadId && receipt.messageId === effect.target.messageId
      ? ('settled' as const)
      : ('unavailable' as const);
  }
  const receipt = await port.restoreReadingRef(effect.origin.readingRef, signal, { refresh: true });
  if (receipt.status !== 'settled') return receipt.status;
  return receipt.exact ? ('settled' as const) : ('unavailable' as const);
}

export function startFromForeground(response: MessageSearchResponse, port: ChatReadingPort | null, threadId: string) {
  if (!port || port.threadId !== threadId) return null;
  const origin = port.captureReadingRef();
  if (!origin) return null;
  const trip = beginMessageReadingTrip(response, { threadId, readingRef: origin.ref });
  return trip ? startMessageReadingSession(trip, origin.persisted) : null;
}

export function startFindPageFromForeground(find: MessageFindContext, port: ChatReadingPort | null, threadId: string) {
  if (!port || port.threadId !== threadId) return null;
  const origin = port.captureReadingRef();
  if (!origin) return null;
  if (!origin.persisted) {
    port.releaseReadingRef(origin.ref);
    return null;
  }
  const started = startMessageReadingSession(
    {
      searchId: find.state.response?.searchId ?? crypto.randomUUID(),
      origin: { threadId, readingRef: origin.ref },
      targets: [],
      generation: 0,
      settledIndex: null,
      pending: null,
      status: 'ready',
    },
    origin.persisted,
    find,
  );
  if (started.persisted && origin.persisted) return started;
  port.releaseReadingRef(origin.ref);
  return null;
}
