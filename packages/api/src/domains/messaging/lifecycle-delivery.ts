import { createHash } from 'node:crypto';
import {
  type DeliveryPresentationContext,
  type HostMessagingLifecycleInput,
  validateMessagingRowInput,
  validateMessagingRowResult,
} from '@clowder-ai/plugin-contract';
import { pickReceiptLine } from './presentation/receipt-lines.js';
import type { LifecycleTarget } from './subscription-delivery.js';

export function lifecycleIdFor(invocationId: string): string {
  return `lifecycle_${createHash('sha256').update(invocationId).digest('hex').slice(0, 32)}`;
}

export function buildDeliveryPresentation(
  threadId: string,
  actor: { kind: 'cat' | 'user' | 'plugin' | 'device' | 'system'; id: string; displayName?: string },
  threadMeta?: { threadShortId?: string; threadTitle?: string; featId?: string; deepLinkUrl?: string },
): DeliveryPresentationContext {
  const displayName = actor.kind === 'plugin' || actor.kind === 'system' ? actor.id : actor.displayName || actor.id;
  const emoji = actor.kind === 'cat' ? '🐱' : actor.kind === 'user' ? '👤' : '🔌';
  return {
    actor: { displayName, emoji },
    thread: {
      shortId: threadMeta?.threadShortId ?? threadId.slice(0, 15),
      ...(threadMeta?.threadTitle === undefined ? {} : { title: threadMeta.threadTitle }),
      ...(threadMeta?.featId === undefined ? {} : { featId: threadMeta.featId }),
    },
    ...(threadMeta?.deepLinkUrl === undefined ? {} : { deepLinkUrl: threadMeta.deepLinkUrl }),
  };
}

export interface LifecycleDeliveryDeps {
  readonly subscribers: (threadId: string) => readonly LifecycleTarget[];
  readonly supportsAction: (subscriberId: string, method: string) => boolean;
  readonly invoke: (subscriberId: string, method: string, input: HostMessagingLifecycleInput) => Promise<unknown>;
  readonly enqueueThread: (threadId: string, operation: () => Promise<void>) => Promise<void>;
  readonly drain: (threadId: string) => Promise<void>;
  readonly presentation: (threadId: string, catId: string) => Promise<DeliveryPresentationContext>;
  /** The invocation's trigger message id — `started.replyTo` for v2 subscriptions (P1.3); none when unknown. */
  readonly triggerMessageId?: (invocationId: string) => Promise<string | undefined>;
  /** The cat's receipt line for a v2 placeholder; the F157 word bank (with its fallback lines) by default. */
  readonly receiptLine?: (catId: string) => string;
  readonly now?: () => number;
  readonly actionTimeoutMs?: number;
  readonly onError?: (fields: { subscriberId: string; lifecycleId: string; state: string; errorKind: string }) => void;
}

interface InvocationState {
  readonly threadId: string;
  readonly lifecycleId: string;
  readonly catId: string;
  presentation?: DeliveryPresentationContext;
  /** What a v2 subscription's started carries beyond presentation; fixed once per invocation. */
  v2Started?: { placeholderLine: string; replyTo?: string };
  catchingUpCount: number;
  blocked: boolean;
  ended: boolean;
  settled: boolean;
  lastTouchedAt: number;
}

const LIFECYCLE_IDLE_TTL_MS = 60 * 60_000;

type LifecycleEventWithoutDeliveryId = HostMessagingLifecycleInput extends infer Event
  ? Event extends HostMessagingLifecycleInput
    ? Omit<Event, 'deliveryId'>
    : never
  : never;

function deliveryIdFor(subscriberId: string, lifecycleId: string, state: string, sequence: number): string {
  const digest = createHash('sha256')
    .update(subscriberId)
    .update('\0')
    .update(lifecycleId)
    .update('\0')
    .update(state)
    .update('\0')
    .update(String(sequence))
    .digest('hex');
  return `delivery_${digest}`;
}

async function awaitLifecycleReceipt(action: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('lifecycle action timed out'), { code: 'TIMEOUT' })),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class LifecycleDelivery {
  private readonly invocations = new Map<string, InvocationState>();
  private readonly starts = new Map<string, Promise<void>>();
  private readonly settledOrder: string[] = [];
  private nextIdleSweepAt = Number.POSITIVE_INFINITY;

  constructor(private readonly deps: LifecycleDeliveryDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private touch(invocationId: string): void {
    const state = this.invocations.get(invocationId);
    if (state) {
      state.lastTouchedAt = this.now();
      this.nextIdleSweepAt = Math.min(this.nextIdleSweepAt, state.lastTouchedAt + LIFECYCLE_IDLE_TTL_MS + 1);
    }
  }

  private pruneIdle(exceptInvocationId?: string): void {
    const now = this.now();
    if (now < this.nextIdleSweepAt) return;
    const cutoff = now - LIFECYCLE_IDLE_TTL_MS;
    let nextIdleSweepAt = Number.POSITIVE_INFINITY;
    for (const [invocationId, state] of this.invocations) {
      if (state.settled || this.starts.has(invocationId)) continue;
      if (invocationId !== exceptInvocationId && state.lastTouchedAt < cutoff) {
        // No terminal evidence exists; eviction must not synthesize settled.
        this.invocations.delete(invocationId);
      } else {
        nextIdleSweepAt = Math.min(nextIdleSweepAt, state.lastTouchedAt + LIFECYCLE_IDLE_TTL_MS + 1);
      }
    }
    this.nextIdleSweepAt = nextIdleSweepAt;
  }

  private async deliverToSubscriber(
    subscriberId: string,
    method: string,
    state: InvocationState,
    event: LifecycleEventWithoutDeliveryId,
    sequence: number,
  ): Promise<void> {
    const deliveryId = deliveryIdFor(subscriberId, state.lifecycleId, event.state, sequence);
    const input = { ...event, deliveryId } as HostMessagingLifecycleInput;
    try {
      if (!validateMessagingRowInput('host.messaging.lifecycle', input).valid) {
        throw new Error('invalid lifecycle input');
      }
      const receipt = await awaitLifecycleReceipt(
        this.deps.invoke(subscriberId, method, input),
        this.deps.actionTimeoutMs ?? 30_000,
      );
      const validated = validateMessagingRowResult('host.messaging.lifecycle', receipt);
      if (!validated.valid || validated.value.deliveryId !== deliveryId) {
        throw new Error('lifecycle receipt mismatch');
      }
    } catch (error) {
      // A package conflict or out-of-order rejection is terminal for this attempt. The Host
      // records one operational audit row, never an event body, and does not retry it.
      this.deps.onError?.({
        subscriberId,
        lifecycleId: state.lifecycleId,
        state: event.state,
        errorKind:
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : error instanceof Error
              ? error.name
              : 'unknown',
      });
    }
  }

  private async emit(
    state: InvocationState,
    event: LifecycleEventWithoutDeliveryId | Promise<LifecycleEventWithoutDeliveryId>,
    sequence = 0,
  ): Promise<void> {
    await this.deps.enqueueThread(state.threadId, async () => {
      const resolvedEvent = await event;
      for (const target of this.deps.subscribers(state.threadId)) {
        if (target.wire || this.deps.supportsAction(target.subscriberId, target.method)) {
          // Declared, then sent: only a v2 subscription gets the receipt line and the trigger id.
          const targeted =
            resolvedEvent.state === 'started' && target.presentationVersion === 'v2' && state.v2Started
              ? { ...resolvedEvent, ...state.v2Started }
              : resolvedEvent;
          await this.deliverToSubscriber(target.subscriberId, target.method, state, targeted, sequence);
        }
      }
    });
  }

  private async start(threadId: string, catId: string, invocationId: string): Promise<InvocationState> {
    this.pruneIdle(invocationId);
    const existing = this.invocations.get(invocationId);
    if (existing) {
      if (existing.threadId !== threadId) throw new Error('lifecycle invocation changed thread');
      this.touch(invocationId);
      await this.starts.get(invocationId);
      return existing;
    }
    const state: InvocationState = {
      threadId,
      lifecycleId: lifecycleIdFor(invocationId),
      catId,
      catchingUpCount: 0,
      blocked: false,
      ended: false,
      settled: false,
      lastTouchedAt: this.now(),
    };
    this.invocations.set(invocationId, state);
    this.nextIdleSweepAt = Math.min(this.nextIdleSweepAt, state.lastTouchedAt + LIFECYCLE_IDLE_TTL_MS + 1);
    // Reserve the shared thread tail before an asynchronous presentation lookup can let a
    // final message overtake started. Queue consumption awaits the presentation in that slot.
    const started = this.emit(
      state,
      Promise.all([this.deps.presentation(threadId, catId), this.v2StartedFields(catId, invocationId)]).then(
        ([presentation, v2Started]) => {
          state.presentation = presentation;
          state.v2Started = v2Started;
          return { lifecycleId: state.lifecycleId, threadId, state: 'started' as const, presentation };
        },
      ),
    );
    this.starts.set(invocationId, started);
    try {
      await started;
    } catch (error) {
      this.invocations.delete(invocationId);
      throw error;
    } finally {
      this.starts.delete(invocationId);
      this.touch(invocationId);
    }
    return state;
  }

  /**
   * P1.3: the old Feishu placeholder always showed a receipt line (the word bank falls back to
   * generic lines), so a v2 started always carries one; `replyTo` lets the package add `→sender`
   * from its own message map and is left out when the invocation has no trigger message.
   */
  private async v2StartedFields(
    catId: string,
    invocationId: string,
  ): Promise<{ placeholderLine: string; replyTo?: string }> {
    const placeholderLine = (this.deps.receiptLine ?? pickReceiptLine)(catId);
    let replyTo: string | undefined;
    try {
      replyTo = await this.deps.triggerMessageId?.(invocationId);
    } catch {
      replyTo = undefined; // a lookup failure only costs the sender suffix, never the started event
    }
    return replyTo ? { placeholderLine, replyTo } : { placeholderLine };
  }

  async onStreamStart(threadId: string, catId: string, invocationId: string): Promise<void> {
    await this.start(threadId, catId, invocationId);
  }

  async onStreamChunk(threadId: string, _text: string, invocationId: string): Promise<void> {
    if (this.invocations.get(invocationId)?.threadId === threadId) this.touch(invocationId);
    this.pruneIdle(invocationId);
  }

  async onClosureCatchingUp(threadId: string, catId: string, invocationId: string): Promise<void> {
    const state = await this.start(threadId, catId, invocationId);
    if (state.blocked || state.settled) return;
    state.catchingUpCount += 1;
    await this.emit(
      state,
      { lifecycleId: state.lifecycleId, threadId: state.threadId, state: 'catching_up' },
      state.catchingUpCount,
    );
  }

  async onClosureBlocked(threadId: string, catId: string, reason: string, invocationId: string): Promise<void> {
    const state = await this.start(threadId, catId, invocationId);
    if (state.blocked || state.settled) return;
    state.blocked = true;
    await this.emit(state, {
      lifecycleId: state.lifecycleId,
      threadId: state.threadId,
      state: 'blocked',
      reason,
      ...(state.presentation?.deepLinkUrl === undefined ? {} : { recoveryUrl: state.presentation.deepLinkUrl }),
    });
  }

  async onStreamEnd(threadId: string, _text: string, invocationId: string): Promise<void> {
    this.pruneIdle(invocationId);
    const state = this.invocations.get(invocationId);
    if (!state || state.ended) return;
    if (state.threadId !== threadId) throw new Error('lifecycle invocation changed thread');
    this.touch(invocationId);
    // Drain is itself enqueued on the same thread tail. It cannot be called from inside emit.
    await this.deps.drain(threadId);
    state.ended = true;
    this.touch(invocationId);
  }

  async cleanupPlaceholders(_threadId: string, _invocationId: string): Promise<void> {
    this.pruneIdle();
  }

  async notifyDeliveryBatchDone(
    threadId: string,
    chainDone: boolean,
    status?: string,
    invocationId?: string,
  ): Promise<void> {
    this.pruneIdle(invocationId);
    if (!invocationId) return;
    const state = this.invocations.get(invocationId);
    if (!state || state.settled || state.threadId !== threadId) return;
    this.touch(invocationId);
    state.settled = true;
    if (!state.ended) {
      // A subscriber failure must not suppress the invocation's terminal signal; the cursor
      // remains unacked and a later normal drain can retry the message with its stable id.
      try {
        await this.deps.drain(threadId);
      } catch {
        // SubscriptionDelivery already records the subscriber-specific failure.
      }
    }
    const outcome =
      status === 'cancelled' || status === 'canceled' || status === 'canceled_by_user'
        ? 'cancelled'
        : state.blocked || status === 'failed' || status === 'error'
          ? 'failed'
          : 'completed';
    await this.emit(state, { lifecycleId: state.lifecycleId, threadId, state: 'settled', chainDone, outcome });
    // Preserve a bounded in-process tombstone so duplicate terminal hooks cannot re-arm
    // started. Stable delivery IDs are the cross-restart idempotency key at the package.
    this.settledOrder.push(invocationId);
    if (this.settledOrder.length > 4096) {
      const oldest = this.settledOrder.shift();
      if (oldest) this.invocations.delete(oldest);
    }
  }
}

export function createLifecycleDelivery(deps: LifecycleDeliveryDeps): LifecycleDelivery {
  return new LifecycleDelivery(deps);
}
