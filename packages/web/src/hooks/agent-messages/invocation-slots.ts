import type { CatInvocationInfo, ThreadState } from '@/stores/chat-types';
import { type ChatState, useChatStore } from '@/stores/chatStore';
import type { BackgroundAgentMessage, HandleBackgroundMessageOptions } from './types';

/**
 * Invocation slots (F108) are liveness truth: which cat is executing which invocation. Slot and
 * catInvocations truth — never message bindings — decide slot cleanup and terminal staleness.
 */
export type ActiveInvocationSlots = Record<string, { catId: string; mode: string; startedAt?: number }>;
type CatInvocations = Record<string, CatInvocationInfo> | undefined;
type Slot = ActiveInvocationSlots[string];

function newestFirst(slots: ActiveInvocationSlots | undefined): Array<[string, Slot]> {
  return Object.entries(slots ?? {}).reverse();
}

export function normalizeInvocationForCat(invocationId: string | undefined, catId: string): string | undefined {
  const suffix = `-${catId}`;
  return invocationId?.endsWith(suffix) ? invocationId.slice(0, -suffix.length) : invocationId;
}

/** Clear only the terminal event's direct identity; late events cannot clear a newer turn. */
export function clearTerminalInvocationIdentity(
  threadId: string,
  catId: string,
  invocationId: string,
  turnInvocationId?: string,
): void {
  const store = useChatStore.getState();
  const isOpen = store.currentThreadId === threadId;
  const direct = (isOpen ? store.catInvocations : store.getThreadState(threadId).catInvocations)?.[catId];
  if (direct?.invocationId !== invocationId) return;
  if (turnInvocationId && direct.turnInvocationId && direct.turnInvocationId !== turnInvocationId) return;
  const patch: Partial<CatInvocationInfo> = {
    invocationId: undefined,
    ...(turnInvocationId ? { turnInvocationId: undefined } : {}),
  };
  if (isOpen) store.setCatInvocation(catId, patch);
  else store.setThreadCatInvocation(threadId, catId, patch);
}

export function findLatestActiveInvocationIdForCat(
  activeInvocations: ActiveInvocationSlots | undefined,
  catId: string,
): string | undefined {
  return newestFirst(activeInvocations).find(([, info]) => info.catId === catId)?.[0];
}

/** Latest slot of the cat that stands for a real invocation (not a reconnect `hydrated-` placeholder). */
function latestRealSlotKey(activeInvocations: ActiveInvocationSlots | undefined, catId: string): string | undefined {
  return newestFirst(activeInvocations).find(
    ([key, info]) => info.catId === catId && !key.startsWith('hydrated-'),
  )?.[0];
}

/** The slot a terminal event ends: an exact key, or (Z9 dual id) the parent slot of its confirmed turn. */
export function findTerminalActiveInvocationSlot(
  activeInvocations: ActiveInvocationSlots | undefined,
  catInvocations: CatInvocations,
  catId: string,
  invocationId: string | undefined,
  turnInvocationId: string | undefined,
): string | undefined {
  const direct = catInvocations?.[catId];
  if (
    turnInvocationId &&
    direct &&
    direct.invocationId === invocationId &&
    direct.turnInvocationId &&
    direct.turnInvocationId !== turnInvocationId
  )
    return undefined;
  const exactKeys = new Set([invocationId, turnInvocationId].flatMap((id) => (id ? [id, `${id}-${catId}`] : [])));
  const exact = newestFirst(activeInvocations).find(([key, info]) => info.catId === catId && exactKeys.has(key));
  if (exact) return exact[0];

  // Slots are keyed by the parent liveness id while terminal events can carry the per-cat turn id.
  // catInvocations confirming this turn under that parent makes the parent slot this event's slot;
  // a newer same-cat slot has a different parent key, so preemption stays safe.
  const terminalTurn = turnInvocationId ?? invocationId;
  if (!terminalTurn || direct?.turnInvocationId !== terminalTurn || !direct.invocationId) return undefined;
  const parent = direct.invocationId;
  return newestFirst(activeInvocations).find(
    ([key, info]) =>
      info.catId === catId && !key.startsWith('hydrated-') && normalizeInvocationForCat(key, catId) === parent,
  )?.[0];
}

/**
 * Stale terminal guard (Bug-G, shared by done + error): true when `invocationId` belongs to an
 * older invocation than the one this cat is executing now, so the event must not touch cat status
 * or global teardown. The freshest signal wins: the latest real slot (intent_mode registers it
 * before invocation_created updates catInvocations), then catInvocations. Without an invocation
 * id, or without any slot/catInvocations evidence, the event is not stale.
 */
export function isStaleTerminalEvent(
  activeInvocations: ActiveInvocationSlots | undefined,
  catInvocations: CatInvocations,
  catId: string,
  invocationId: string | undefined,
  turnInvocationId?: string,
): boolean {
  if (!invocationId) return false;
  const direct = catInvocations?.[catId];
  if (
    turnInvocationId &&
    direct?.invocationId === invocationId &&
    direct.turnInvocationId &&
    direct.turnInvocationId !== turnInvocationId
  )
    return true;
  const latestRealSlot = normalizeInvocationForCat(latestRealSlotKey(activeInvocations, catId), catId);
  if (latestRealSlot === invocationId) return false;
  // The event carries this cat's turn id under the parent the latest slot confirms.
  if (direct?.turnInvocationId === invocationId && direct.invocationId && latestRealSlot === direct.invocationId) {
    return false;
  }
  if (latestRealSlot !== undefined) return true;
  if (direct?.turnInvocationId === invocationId) return false;
  return direct?.invocationId !== undefined && direct.invocationId !== invocationId;
}

type OwnershipActions = Pick<
  ChatState,
  'addActiveInvocation' | 'removeActiveInvocation' | 'replaceThreadTargetCats' | 'setCatStatus'
>;

/**
 * Open thread: invocation_created is authoritative for the cat owning an invocation. Rebind a stale
 * primary slot to it, but never collapse an explicit sibling slot from parallel execution.
 */
export function reconcileInvocationOwnership(nextCatId: string, invocationId: string, actions: OwnershipActions) {
  const store = useChatStore.getState();
  const activeInvocations = store.activeInvocations ?? {};
  const primarySlot = activeInvocations[invocationId];
  if (primarySlot?.catId === nextCatId) return;
  const hasExplicitNextCatSlot =
    Boolean(activeInvocations[`${invocationId}-${nextCatId}`]) ||
    Object.values(activeInvocations).some((slot) => slot.catId === nextCatId);
  if (hasExplicitNextCatSlot) return;

  if (primarySlot) {
    actions.removeActiveInvocation(invocationId);
    actions.addActiveInvocation(invocationId, nextCatId, primarySlot.mode, primarySlot.startedAt);
  } else {
    actions.addActiveInvocation(invocationId, nextCatId, store.intentMode ?? 'execute');
  }

  const currentTargets = Array.isArray(store.targetCats) ? store.targetCats : [];
  if (store.currentThreadId && currentTargets.length === 1 && currentTargets[0] !== nextCatId) {
    actions.replaceThreadTargetCats(store.currentThreadId, [nextCatId]);
  }
  const currentStatus = store.catStatuses?.[nextCatId];
  const alreadyRunning =
    currentStatus === 'spawning' ||
    currentStatus === 'streaming' ||
    currentStatus === 'alive_but_silent' ||
    currentStatus === 'suspected_stall';
  if (!alreadyRunning) actions.setCatStatus(nextCatId, 'spawning');
}

/** Background: turn output marks the thread busy and registers this invocation's slot. */
export function markThreadInvocationActive(msg: BackgroundAgentMessage, options: HandleBackgroundMessageOptions) {
  if (!options.store.getThreadState(msg.threadId).isLoading) {
    options.store.setThreadLoading(msg.threadId, true);
  }
  if (msg.invocationId) {
    options.store.addThreadActiveInvocation(msg.threadId, msg.invocationId, msg.catId, 'execute');
  } else {
    options.store.setThreadHasActiveInvocation(msg.threadId, true);
  }
}

/** F869 multi-cat: remove only this cat's slot and sweep a synthetic `hydrated-` slot of the cat. */
function removeBackgroundCatSlots(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
  before: ThreadState,
) {
  const { store } = options;
  if (!msg.invocationId) {
    const catSlot = findLatestActiveInvocationIdForCat(before.activeInvocations, msg.catId);
    if (catSlot) store.removeThreadActiveInvocation(msg.threadId, catSlot);
    else store.setThreadHasActiveInvocation(msg.threadId, false);
    return;
  }
  const slot = findTerminalActiveInvocationSlot(
    before.activeInvocations,
    before.catInvocations,
    msg.catId,
    msg.invocationId,
    msg.turnInvocationId,
  );
  if (slot) store.removeThreadActiveInvocation(msg.threadId, slot);
  const orphan = findLatestActiveInvocationIdForCat(store.getThreadState(msg.threadId).activeInvocations, msg.catId);
  if (orphan?.startsWith('hydrated-')) store.removeThreadActiveInvocation(msg.threadId, orphan);
}

/** Background: a terminal event ends this cat's slot; the last tracked slot clears the target cats. */
export function markThreadInvocationComplete(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): void {
  const { store } = options;
  store.setThreadLoading(msg.threadId, false);
  if (msg.invocationId) {
    clearTerminalInvocationIdentity(msg.threadId, msg.catId, msg.invocationId, msg.turnInvocationId);
  }
  const before = store.getThreadState(msg.threadId);
  const slotsBefore = Object.keys(before.activeInvocations ?? {}).length;
  removeBackgroundCatSlots(msg, options, before);
  // Only a real >0 → 0 transition: stale cats otherwise accumulate via merge semantics.
  if (slotsBefore > 0 && Object.keys(store.getThreadState(msg.threadId).activeInvocations ?? {}).length === 0) {
    store.replaceThreadTargetCats(msg.threadId, []);
  }
}
