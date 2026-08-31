import { isDeepStrictEqual } from 'node:util';
import type {
  LifecycleDispatchRef,
  LifecycleQueueSnapshot,
  LifecycleResponseBubble,
  ReorderVisibleLifecycleEntriesCommand,
} from '@cat-cafe/shared';
import type { LifecycleTerminalInput } from './message-lifecycle-validation.js';
import { isLifecycleTerminalInput, validateLifecycleQueueEntry } from './message-lifecycle-validation.js';

export type { LifecycleQueueEntryValidation, LifecycleTerminalInput } from './message-lifecycle-validation.js';
export { validateLifecycleQueueEntry } from './message-lifecycle-validation.js';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export type ApplyVisibleQueueOrderResult =
  | { readonly outcome: 'applied'; readonly snapshot: LifecycleQueueSnapshot }
  | {
      readonly outcome: 'conflict';
      readonly reason:
        | 'stale_revision'
        | 'invalid_revision'
        | 'invalid_snapshot'
        | 'scope_mismatch'
        | 'invalid_order'
        | 'visible_set_changed';
    };

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every((value) => rightSet.has(value));
}

/** Apply a complete visible-row reorder as one immutable revision transition. */
export function applyVisibleQueueOrder(
  snapshot: LifecycleQueueSnapshot,
  command: ReorderVisibleLifecycleEntriesCommand,
  nextRevision: string,
): ApplyVisibleQueueOrderResult {
  if (command.expectedQueueRevision !== snapshot.revision) {
    return { outcome: 'conflict', reason: 'stale_revision' };
  }
  if (!isNonEmptyString(nextRevision) || nextRevision === snapshot.revision) {
    return { outcome: 'conflict', reason: 'invalid_revision' };
  }
  if (
    !isNonEmptyString(snapshot.revision) ||
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.some((entry) => !validateLifecycleQueueEntry(entry).valid) ||
    new Set(snapshot.entries.map((entry) => entry.id)).size !== snapshot.entries.length
  ) {
    return { outcome: 'conflict', reason: 'invalid_snapshot' };
  }
  if (snapshot.entries.some((entry) => entry.threadId !== command.threadId)) {
    return { outcome: 'conflict', reason: 'scope_mismatch' };
  }
  if (new Set(command.orderedVisibleEntryIds).size !== command.orderedVisibleEntryIds.length) {
    return { outcome: 'conflict', reason: 'invalid_order' };
  }
  if (new Set(snapshot.reorderableVisibleEntryIds).size !== snapshot.reorderableVisibleEntryIds.length) {
    return { outcome: 'conflict', reason: 'visible_set_changed' };
  }
  if (!sameStringSet(snapshot.reorderableVisibleEntryIds, command.orderedVisibleEntryIds)) {
    return { outcome: 'conflict', reason: 'visible_set_changed' };
  }

  const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
  if (
    command.orderedVisibleEntryIds.some((entryId) => {
      const entry = byId.get(entryId);
      return !entry || entry.kind === 'private_input';
    })
  ) {
    return { outcome: 'conflict', reason: 'visible_set_changed' };
  }

  const positions = new Map(command.orderedVisibleEntryIds.map((entryId, position) => [entryId, position]));
  return {
    outcome: 'applied',
    snapshot: {
      revision: nextRevision,
      reorderableVisibleEntryIds: [...command.orderedVisibleEntryIds],
      entries: snapshot.entries.map((entry) => {
        const position = positions.get(entry.id);
        return position === undefined ? { ...entry } : { ...entry, position };
      }),
    },
  };
}

export type AdvanceDispatchRefResult =
  | { readonly outcome: 'applied' | 'replayed'; readonly ref: LifecycleDispatchRef }
  | { readonly outcome: 'conflict'; readonly reason: 'target_mismatch' | 'status_mismatch' | 'phase_regression' };

function sameDispatchRef(left: LifecycleDispatchRef, right: LifecycleDispatchRef): boolean {
  return (
    left.targetId === right.targetId &&
    left.phase === right.phase &&
    (left.phase === 'assigned' || (right.phase !== 'assigned' && left.statusMessageId === right.statusMessageId))
  );
}

/** Monotonic derived projection reducer; it never terminalizes a canonical owner. */
export function advanceDispatchRef(
  current: LifecycleDispatchRef,
  next: LifecycleDispatchRef,
): AdvanceDispatchRefResult {
  if (current.targetId !== next.targetId) return { outcome: 'conflict', reason: 'target_mismatch' };
  if (sameDispatchRef(current, next)) return { outcome: 'replayed', ref: current };
  if (current.phase === next.phase) {
    return { outcome: 'conflict', reason: 'status_mismatch' };
  }
  if (current.phase === 'settled' || next.phase === 'assigned') {
    return { outcome: 'conflict', reason: 'phase_regression' };
  }
  if (current.phase === 'dispatched' && next.phase === 'settled' && current.statusMessageId !== next.statusMessageId) {
    return { outcome: 'conflict', reason: 'status_mismatch' };
  }
  return { outcome: 'applied', ref: next };
}

export type ApplyLifecycleTerminalResult =
  | { readonly outcome: 'applied' | 'replayed'; readonly bubble: LifecycleResponseBubble }
  | { readonly outcome: 'conflict'; readonly reason: 'different_terminal' | 'invalid_terminal' };

function sameTerminal(bubble: LifecycleResponseBubble, terminal: LifecycleTerminalInput): boolean {
  return (
    bubble.status === terminal.status &&
    bubble.completedAt === terminal.completedAt &&
    bubble.reason === terminal.reason &&
    isDeepStrictEqual(bubble.body, terminal.body)
  );
}

/** Commit/replay the one durable delivery-result terminal for an admitted bubble. */
export function applyLifecycleTerminal(
  bubble: LifecycleResponseBubble,
  terminal: LifecycleTerminalInput,
): ApplyLifecycleTerminalResult {
  if (!isLifecycleTerminalInput(terminal) || terminal.completedAt < bubble.startedAt) {
    return { outcome: 'conflict', reason: 'invalid_terminal' };
  }
  if (bubble.status !== 'processing') {
    return sameTerminal(bubble, terminal)
      ? { outcome: 'replayed', bubble }
      : { outcome: 'conflict', reason: 'different_terminal' };
  }
  return { outcome: 'applied', bubble: { ...bubble, ...terminal } };
}

export type { LifecycleQueueOrderKey } from './message-lifecycle-queue-order.js';
export { compareLifecycleQueueEntries } from './message-lifecycle-queue-order.js';
