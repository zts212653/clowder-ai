/**
 * F322 original-B: whose queue is this?
 *
 * The chat store keeps the CURRENT thread's queue flat (`queue` / `queuePaused` / `queuePauseReason`) and every other
 * thread's under `threadStates[threadId]`. The one-row surface takes an explicit threadId and sends its commands to that
 * thread, so what it shows must come from that same thread: the rule here is the one `selectThreadLiveness` applies to
 * liveness. A thread the store knows nothing about is `known: false` — it is NOT padded with the current thread's queue
 * ("show A, operate B"), and nothing may be sent for it.
 */
import type { ChatState } from '@/stores/chatStore';

const isCurrent = (state: ChatState, threadId: string) => !state.currentThreadId || state.currentThreadId === threadId;

export function scopedQueue(state: ChatState, threadId: string) {
  return isCurrent(state, threadId) ? state.queue : state.threadStates?.[threadId]?.queue;
}

export function scopedQueuePaused(state: ChatState, threadId: string) {
  return isCurrent(state, threadId) ? state.queuePaused : state.threadStates?.[threadId]?.queuePaused;
}

export function scopedQueuePauseReason(state: ChatState, threadId: string) {
  return isCurrent(state, threadId) ? state.queuePauseReason : state.threadStates?.[threadId]?.queuePauseReason;
}

/** True when the store holds data for this thread's queue (the current thread always does). */
export function queueKnownFor(state: ChatState, threadId: string): boolean {
  return isCurrent(state, threadId) || state.threadStates?.[threadId] !== undefined;
}
