import { getCachedCats } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { invalidateSidebarProjection } from '@/utils/sidebar-thread-snapshot';
import {
  findTerminalActiveInvocationSlot,
  isStaleTerminalEvent,
  markThreadInvocationComplete,
} from './invocation-slots';
import type { BackgroundAgentMessage, HandleBackgroundMessageOptions } from './types';

/**
 * PR-3a: what a page does when a lifecycle snapshot reaches it through the user room.
 *
 * A background thread will stop receiving its room's stream, so the user-room snapshot becomes the
 * only carrier of "this turn ended": it refreshes the Sidebar, ends the turn's slot, and is the one
 * owner of the background completed / failed toast (the room handlers no longer toast).
 *
 * Writing the snapshot and deciding whether to alert are separate. Only the store seam knows whether
 * a commit is new, so only a snapshot it marked `applied` may alert; `replayed` repairs, and the
 * unmarked snapshots each exit still emits during migration, only write. The local record is no
 * evidence either way: a page without this thread cached sees a replay as "unseen", and the unmarked
 * snapshot of the same terminal can land before the `applied` one (the seam resolves its owner room
 * asynchronously), so the alert never asks what the store held before.
 *
 * Ending the slot is a third, separate decision: it is judged against the thread's current slots and
 * catInvocations, so a snapshot of an older run never ends a newer run's live state.
 */
export type LifecycleCommit = 'applied' | 'replayed';

export function lifecycleCommitOf(value: unknown): LifecycleCommit | undefined {
  return value === 'applied' || value === 'replayed' ? value : undefined;
}

export function isTerminalLifecycleMessage(message: ChatMessage | undefined): boolean {
  const lifecycle = message?.lifecycle;
  if (!lifecycle) return false;
  if (lifecycle.kind === 'delivery_failure') return true;
  return lifecycle.kind === 'response' && lifecycle.status !== 'processing';
}

const MAX_ALERTED_MESSAGES = 500;
const alertedMessageIds = new Set<string>();

function claimAlert(messageId: string): boolean {
  if (alertedMessageIds.has(messageId)) return false;
  alertedMessageIds.add(messageId);
  if (alertedMessageIds.size > MAX_ALERTED_MESSAGES) {
    const oldest = alertedMessageIds.values().next().value;
    if (oldest !== undefined) alertedMessageIds.delete(oldest);
  }
  return true;
}

export function __resetLifecycleAlertsForTests(): void {
  alertedMessageIds.clear();
}

function catName(catId: string | undefined | null): string {
  if (!catId) return '猫猫';
  const cat = getCachedCats().find((candidate) => candidate.id === catId);
  return cat ? formatCatDisplayName(cat) : catId;
}

type Toast = Parameters<ReturnType<typeof useToastStore.getState>['addToast']>[0];

function alertFor(threadId: string, message: ChatMessage): Toast | null {
  const lifecycle = message.lifecycle;
  if (lifecycle?.kind === 'delivery_failure') {
    return { type: 'error', title: '出错', message: message.content || '消息没有送达', threadId, duration: 8000 };
  }
  if (lifecycle?.kind !== 'response') return null;
  const name = catName(message.catId);
  if (lifecycle.status === 'completed') {
    return {
      type: 'success',
      title: `${name} 完成`,
      message: message.content || '已完成处理',
      threadId,
      duration: 5000,
    };
  }
  if (lifecycle.status === 'failed' || lifecycle.status === 'interrupted') {
    return {
      type: 'error',
      title: `${name} 出错`,
      message: lifecycle.reason || message.content || 'Unknown error',
      threadId,
      duration: 8000,
    };
  }
  // A cancel follows an explicit Stop the person made themselves: nothing to announce.
  return null;
}

/**
 * End the slot this turn held, with the identity matching and stale guard the room's terminal
 * events use (background-handler handleDone / handleError). The snapshot's own ids are not enough:
 * `markThreadInvocationComplete` also sweeps the cat's `hydrated-` placeholder, which may stand for a
 * newer run. A snapshot older than what the thread's slots / catInvocations say the cat runs now
 * only removes the slot keyed by its own identity, and touches nothing that could be another run's.
 */
function endBackgroundSlot(threadId: string, message: ChatMessage): void {
  const lifecycle = message.lifecycle;
  if (lifecycle?.kind !== 'response' || !message.catId) return;
  const catId = message.catId;
  const parentInvocationId = message.extra?.stream?.invocationId;
  // Without the parent liveness id a match would fall back to "the cat's latest slot" and could
  // end a newer turn; leave those to the /queue reconcile and the stale-slot watchdog.
  if (!parentInvocationId) return;
  const turnInvocationId = message.extra?.stream?.turnInvocationId ?? lifecycle.invocationId;
  const store = useChatStore.getState();
  const { activeInvocations, catInvocations } = store.getThreadState(threadId);
  if (isStaleTerminalEvent(activeInvocations, catInvocations, catId, parentInvocationId, turnInvocationId)) {
    const ownSlot = findTerminalActiveInvocationSlot(
      activeInvocations,
      catInvocations,
      catId,
      parentInvocationId,
      turnInvocationId,
    );
    if (ownSlot) store.removeThreadActiveInvocation(threadId, ownSlot);
    return;
  }
  const terminal = {
    type: 'done',
    threadId,
    catId,
    invocationId: parentInvocationId,
    turnInvocationId,
    timestamp: Date.now(),
  } as BackgroundAgentMessage;
  const options = {
    store,
    nextBgSeq: () => 0,
    addToast: () => {},
  } as HandleBackgroundMessageOptions;
  markThreadInvocationComplete(terminal, options);
}

/** The background completed / failed toast: once per message, and only for a commit the seam marked new. */
function alertBackgroundTerminal(threadId: string, message: ChatMessage, commit: LifecycleCommit | undefined): void {
  if (commit !== 'applied') return;
  const toast = alertFor(threadId, message);
  if (!toast || !claimAlert(message.id)) return;
  useToastStore.getState().addToast(toast);
}

export interface ObservedLifecycleSnapshot {
  threadId: string;
  /** The snapshot as written to the store. */
  message: ChatMessage;
  commit: LifecycleCommit | undefined;
}

export function observeLifecycleSnapshot({ threadId, message, commit }: ObservedLifecycleSnapshot): void {
  if (!isTerminalLifecycleMessage(message)) return;
  void invalidateSidebarProjection();
  if (threadId === useChatStore.getState().currentThreadId) return;
  endBackgroundSlot(threadId, message);
  alertBackgroundTerminal(threadId, message, commit);
}
