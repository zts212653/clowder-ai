import { finishNamedMessage } from '@/hooks/named-message-writer';
import { useChatStore } from '@/stores/chatStore';
import type { ActiveContext, ActiveStoreActions, OpenThreadRows } from './active-context';
import {
  errorRowExtra,
  invocationErrorRowId,
  isRecoverableInFlightError,
  labelledErrorContent,
  upsertErrorRow,
} from './error-rows';
import {
  clearTerminalInvocationIdentity,
  findLatestActiveInvocationIdForCat,
  findTerminalActiveInvocationSlot,
  isStaleTerminalEvent,
} from './invocation-slots';
import { namedTarget } from './named-target';
import type { AgentMsg } from './types';

/**
 * Open-thread terminal events. The message a done/error names stops streaming — exactly that
 * message, even for a late event of an older invocation. The stale guard (slot/catInvocations
 * truth) only protects cat status, slots and the global teardown of the newer invocation.
 */

function isTerminalStale(msg: AgentMsg): boolean {
  const state = useChatStore.getState();
  return isStaleTerminalEvent(
    state.activeInvocations,
    state.catInvocations,
    msg.catId,
    msg.invocationId,
    msg.turnInvocationId,
  );
}

function activeSlots() {
  return useChatStore.getState().activeInvocations ?? {};
}

/**
 * F108/F869: remove only this cat's slot (primary key or `${invocationId}-${catId}`). A synthetic
 * `hydrated-` slot of the cat yields to a real terminal event, but not to a stale one: after a
 * reconnect it may represent the invocation that is still running (砚砚 R10).
 */
function removeTerminalSlots(
  msg: AgentMsg,
  stale: boolean,
  actions: ActiveStoreActions,
  done?: { terminalSlotKey: string | undefined },
): void {
  if (msg.invocationId) {
    const state = useChatStore.getState();
    const slot = done
      ? done.terminalSlotKey
      : findTerminalActiveInvocationSlot(
          activeSlots(),
          state.catInvocations,
          msg.catId,
          msg.invocationId,
          msg.turnInvocationId,
        );
    if (slot) actions.removeActiveInvocation(slot);
    if (!stale) {
      const orphan = findLatestActiveInvocationIdForCat(activeSlots(), msg.catId);
      if (orphan?.startsWith('hydrated-')) actions.removeActiveInvocation(orphan);
    }
    return;
  }
  const catSlot = findLatestActiveInvocationIdForCat(activeSlots(), msg.catId);
  if (catSlot) actions.removeActiveInvocation(catSlot);
  // A non-final done of a slotless cat must not clear the flag while other cats still run.
  else if (!done || Object.keys(activeSlots()).length === 0) actions.setHasActiveInvocation(false);
}

/** F108 P1: global execution state clears only when the last invocation ends. */
function teardownWhenIdle(ctx: ActiveContext): void {
  if (Object.keys(activeSlots()).length > 0) return;
  ctx.actions.setLoading(false);
  ctx.actions.setIntentMode(null);
  ctx.actions.clearCatStatuses();
}

/** The cat finished: status done and its task snapshot completed (an interrupted one stays interrupted). */
function markCatDone(msg: AgentMsg, actions: ActiveStoreActions): void {
  actions.setCatStatus(msg.catId, 'done');
  const progress = useChatStore.getState().catInvocations?.[msg.catId]?.taskProgress;
  if (!progress?.tasks?.length) return;
  actions.setCatInvocation(msg.catId, {
    taskProgress: {
      ...progress,
      snapshotStatus: progress.snapshotStatus === 'interrupted' ? 'interrupted' : 'completed',
      lastUpdate: Date.now(),
    },
  });
}

export function handleActiveDone(msg: AgentMsg, threadId: string, ctx: ActiveContext): void {
  const { actions } = ctx;
  const state = useChatStore.getState();
  const stale = isTerminalStale(msg);
  const terminalSlotKey = findTerminalActiveInvocationSlot(
    state.activeInvocations,
    state.catInvocations,
    msg.catId,
    msg.invocationId,
    msg.turnInvocationId,
  );

  // done ends the named response's streaming but never writes its body: the committed response
  // snapshot (published at each target's done) is the final truth, and `done.content` only
  // duplicates it — an empty one must not wipe what streamed.
  const target = namedTarget(msg, threadId);
  if (target) finishNamedMessage(target);
  if (!stale) markCatDone(msg, actions);
  // Terminal events clean up the exact invocation identity without creating another message.
  if (msg.invocationId) {
    clearTerminalInvocationIdentity(threadId, msg.catId, msg.invocationId, msg.turnInvocationId);
  }
  // This cat is done even when more cats follow (isFinal=false): its slot always goes.
  removeTerminalSlots(msg, stale, actions, { terminalSlotKey });
  // Cloud R14: a stale final done must not tear down a newer invocation's execution state.
  if (msg.isFinal && !stale) teardownWhenIdle(ctx);
}

/** The cat failed: status error and its task snapshot interrupted with the error as reason. */
function markCatFailed(msg: AgentMsg, actions: ActiveStoreActions): void {
  actions.setCatStatus(msg.catId, 'error');
  const progress = useChatStore.getState().catInvocations?.[msg.catId]?.taskProgress;
  if (!progress?.tasks?.length) return;
  actions.setCatInvocation(msg.catId, {
    taskProgress: {
      ...progress,
      snapshotStatus: 'interrupted',
      interruptReason: msg.error ?? 'Unknown error',
      lastUpdate: Date.now(),
    },
  });
}

/** No admitted response (preflight / registration failure): the error row is the only carrier. */
function upsertUnansweredErrorRow(
  msg: AgentMsg,
  timeoutDiag: Record<string, unknown> | null,
  rows: OpenThreadRows,
): void {
  const extra = errorRowExtra(timeoutDiag, msg.metadata?.cliDiagnostics);
  upsertErrorRow(rows, {
    id: invocationErrorRowId(msg) ?? `err-${Date.now()}-${msg.catId}`,
    type: 'system',
    variant: 'error',
    catId: msg.catId,
    content: labelledErrorContent(msg),
    timestamp: Date.now(),
    ...(extra ? { extra } : {}),
  });
}

export function handleActiveError(msg: AgentMsg, threadId: string, ctx: ActiveContext): void {
  const { actions } = ctx;
  const stale = isTerminalStale(msg);
  const recoverable = isRecoverableInFlightError(msg);
  // Cloud R9 P2: consumed by every error, so diagnostics never explain a later, unrelated one.
  const timeoutDiag = msg.catId ? ctx.timeoutDiagnostics.take(threadId, msg.catId) : null;

  // The failure belongs to the response the error names: it stops streaming there and the response
  // renders its own failed notice from its terminal snapshot — no second row expresses the result.
  const target = namedTarget(msg, threadId);
  if (target && !recoverable) finishNamedMessage(target);
  if (!stale && !recoverable) markCatFailed(msg, actions);
  if (!stale && !target) upsertUnansweredErrorRow(msg, timeoutDiag, ctx.rows);

  // Only a final error ends the invocation; a size-0 check on a non-final one would misfire in
  // serial gaps. Slot cleanup for msg.invocationId is self-guarded by the slot's cat.
  if (!msg.isFinal) return;
  if (msg.invocationId) {
    clearTerminalInvocationIdentity(threadId, msg.catId, msg.invocationId, msg.turnInvocationId);
  }
  removeTerminalSlots(msg, stale, actions);
  if (!stale) teardownWhenIdle(ctx);
}
