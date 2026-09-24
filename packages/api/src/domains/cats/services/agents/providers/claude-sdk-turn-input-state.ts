import { randomUUID } from 'node:crypto';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type IdentifiedSdkUserMessage = SDKUserMessage & { uuid: string };

class AsyncInputQueue<T> implements AsyncIterable<T> {
  private readonly values: Array<{ value: T; onDequeued?: () => void }> = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T, onDequeued?: () => void): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) {
      onDequeued?.();
      waiter({ value, done: false });
    } else {
      this.values.push({ value, ...(onDequeued ? { onDequeued } : {}) });
    }
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.values.length = 0;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const entry = this.values.shift();
        if (entry !== undefined) {
          entry.onDequeued?.();
          return Promise.resolve({ value: entry.value, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolveNext) => this.waiters.push(resolveNext));
      },
    };
  }
}

export function createSdkUserMessage(text: string, sessionId: string, uuid = randomUUID()): IdentifiedSdkUserMessage {
  return {
    type: 'user',
    uuid,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function resultConsumedInputIds(result: Record<string, unknown>): string[] {
  if (Array.isArray(result.user_message_uuids)) {
    return result.user_message_uuids.filter((value): value is string => typeof value === 'string');
  }
  return typeof result.user_message_uuid === 'string' ? [result.user_message_uuid] : [];
}

function resultQueuedTurnCount(result: Record<string, unknown>): number | undefined {
  const count = result.queued_turn_count;
  return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function deleteOldestPendingInput(pendingInputIds: Set<string>, inputOrdinals: Map<string, number>): void {
  const oldestPendingId = pendingInputIds.values().next().value;
  if (oldestPendingId !== undefined) {
    pendingInputIds.delete(oldestPendingId);
    inputOrdinals.delete(oldestPendingId);
  }
}

function settleProviderOwnedTurnInputs(
  providerOwnedInputIds: Set<string>,
  inputOrdinals: Map<string, number>,
  result: Record<string, unknown>,
): boolean {
  const consumedIds = resultConsumedInputIds(result);
  const snapshotUpperBound = consumedIds.reduce<number | undefined>((latest, id) => {
    const ordinal = inputOrdinals.get(id);
    if (ordinal === undefined) return latest;
    return latest === undefined ? ordinal : Math.max(latest, ordinal);
  }, undefined);
  for (const id of consumedIds) providerOwnedInputIds.delete(id);

  const queuedTurnCount = resultQueuedTurnCount(result);
  if (queuedTurnCount !== undefined && snapshotUpperBound !== undefined) {
    // SDK 0.3.267 defines queued_turn_count as the command-queue snapshot at
    // result time. The echoed input identity bounds which accepted sends that
    // snapshot can describe, so later prefetched inputs cannot be consumed by
    // an older result.
    const snapshotPendingIds = [...providerOwnedInputIds].filter(
      (id) => (inputOrdinals.get(id) ?? Number.POSITIVE_INFINITY) <= snapshotUpperBound,
    );
    while (snapshotPendingIds.length > queuedTurnCount) {
      const id = snapshotPendingIds.shift();
      if (id === undefined) break;
      providerOwnedInputIds.delete(id);
      inputOrdinals.delete(id);
    }
  } else if (consumedIds.length === 0) {
    deleteOldestPendingInput(providerOwnedInputIds, inputOrdinals);
  }
  for (const id of consumedIds) inputOrdinals.delete(id);
  return providerOwnedInputIds.size === 0;
}

/** Exact locally-queued → provider-owned → result-settled turn state. */
export class ClaudeSdkTurnInputState {
  readonly input: AsyncIterable<SDKUserMessage>;
  private readonly queue = new AsyncInputQueue<SDKUserMessage>();
  private readonly locallyQueuedIds = new Set<string>();
  private readonly providerOwnedIds = new Set<string>();
  private readonly ordinals = new Map<string, number>();
  private nextOrdinal = 0;
  private activeDispatches = 0;
  private terminalWaitingForDispatch = false;
  private accepting = true;

  constructor() {
    this.input = this.queue;
  }

  get isAccepting(): boolean {
    return this.accepting;
  }

  push(message: IdentifiedSdkUserMessage): boolean {
    this.locallyQueuedIds.add(message.uuid);
    this.ordinals.set(message.uuid, ++this.nextOrdinal);
    const accepted = this.queue.push(message, () => {
      this.locallyQueuedIds.delete(message.uuid);
      this.providerOwnedIds.add(message.uuid);
    });
    if (accepted) this.terminalWaitingForDispatch = false;
    else {
      this.locallyQueuedIds.delete(message.uuid);
      this.ordinals.delete(message.uuid);
    }
    return accepted;
  }

  beginDispatch(): void {
    this.activeDispatches += 1;
  }

  finishDispatch(): boolean {
    this.activeDispatches -= 1;
    return this.closeAfterTerminalIfIdle();
  }

  settleResult(result: Record<string, unknown>): boolean {
    this.terminalWaitingForDispatch = settleProviderOwnedTurnInputs(this.providerOwnedIds, this.ordinals, result);
    return this.closeAfterTerminalIfIdle();
  }

  closeAfterTerminalIfIdle(): boolean {
    if (
      !this.terminalWaitingForDispatch ||
      this.locallyQueuedIds.size !== 0 ||
      this.providerOwnedIds.size !== 0 ||
      this.activeDispatches !== 0
    ) {
      return false;
    }
    this.close();
    return true;
  }

  close(): void {
    this.accepting = false;
    this.queue.close();
  }
}
