/**
 * F202 Train C1 — Host-driven outbound to subscribing plugins.
 *
 * THE SHAPE. A subscriber declares which thread it wants; when that thread publishes a complete
 * message envelope the Host invokes the package action registered for it. External runtimes
 * that still speak the frozen protocol keep using `host.messaging.deliver`; in-process modules
 * receive the same envelope through their own declared action name without seeing a handle.
 *
 * THIS MODULE HAS NO NOTION OF A PLUGIN. It knows only that N sinks implement the standard
 * delivery row and which of them are owed this thread's messages. A package relaying to an IM platform, a
 * front-desk subscriber, and — once the UI's 112 scattered `broadcastToRoom` call sites are
 * converged onto it — the live view itself are all the same kind of thing here, differing only
 * in the sink that carries the call.
 *
 * WHY THE LOOP IS HERE AND NOT IN EVERY PLUGIN. The durable half already exists and is already
 * published: `subscribe`/`read`/`ack` carry the cursor, the replay floor and the INV-9 stale
 * signal. This driver is a Host-side consumer of the Host's own published API, so there is one
 * consume loop with one set of failure semantics instead of one per plugin author. The only
 * surface this adds is the direction itself — calling a plugin.
 *
 * DELIVERY GUARANTEE. The cursor advances only on an accepted call: a page is acked after every
 * event in it was accepted, so a plugin that was briefly down comes back to its messages rather
 * than to a hole. Retries keep the same Host-issued deliveryId, including a crash between remote
 * acceptance and cursor ack, so the receiving adapter can settle the call idempotently instead
 * of producing a duplicate message in someone's chat.
 */

import { createHash } from 'node:crypto';

import type { DeliveryPresentationContext, MessageOutputEvent } from '@clowder-ai/plugin-contract';
import type { HostMessagingDeliveryPort, HostPluginInvocationPort } from '../plugin/carrier/host-invocation.js';
import { lifecycleIdFor } from './lifecycle-delivery.js';
import type { MediaEntitlementLedger } from './media-entitlements.js';

/**
 * The messaging domain identifies a subscriber by `pluginInstanceId`; that field is its name for
 * whoever holds the handle, not a claim that the subscriber is a package.
 */
interface DeliveryCallContext {
  readonly pluginInstanceId: string;
}

export interface SubscriptionDeliveryMessaging {
  subscribe(ctx: DeliveryCallContext, handleId: string): Promise<{ subscriptionId: string }>;
  read(
    ctx: DeliveryCallContext,
    subscriptionId: string,
    options: { limit?: number },
  ): Promise<{
    readonly events: readonly MessageOutputEvent[];
    readonly ackToken: string | null;
    readonly stale: boolean;
  }>;
  ack(ctx: DeliveryCallContext, subscriptionId: string, token: string): Promise<void>;
}

export interface SubscriptionDeliveryDeps {
  readonly messaging: SubscriptionDeliveryMessaging;
  readonly presentation: (
    threadId: string,
    actor: { kind: 'cat' | 'user' | 'plugin' | 'device' | 'system'; id: string },
  ) => Promise<DeliveryPresentationContext>;
  /** The already-published `host.messaging.deliver` direction. */
  readonly delivery: HostMessagingDeliveryPort & Partial<Pick<HostPluginInvocationPort, 'invoke'>>;
  readonly entitlements?: Pick<MediaEntitlementLedger, 'grantMany' | 'revoke'>;
  readonly actionTimeoutMs?: number;
  readonly resolveInvocationId?: (messageId: string) => Promise<string | undefined>;
  /** A grant or action failure is operationally visible without logging envelope contents. */
  readonly onError?: (fields: { subscriberId: string; threadId: string; errorKind: string }) => void;
  /** Events per read page. */
  readonly readLimit?: number;
  /**
   * Pages drained per call before yielding. A backlog is not lost — the cursor holds it and the
   * next drain continues — but one thread cannot monopolise the Host either.
   */
  readonly maxPagesPerDrain?: number;
}

/**
 * What a subscriber declares about which of the thread's messages it wants. Declared by the
 * subscriber rather than decided by the Host, but applied by the Host — a subscriber filtering
 * itself would already have received what it wanted excluded.
 */
export interface SubscriptionFilter {
  /**
   * Opt in to being handed back the messages this subscriber itself authored. Off by default,
   * and the default is the whole point.
   *
   * A package that relays a thread outward is also subscribed to it, so if its own relayed
   * message comes back it relays that onward too — one inbound "hi" becoming an endless
   * conversation on somebody's real platform. Making echo opt-out would have put that outcome
   * one forgotten line away in every relaying package, and `filter` is an untyped pocket
   * (`additionalProperties: true`, absent from `required`), so a misspelled key, a string
   * `"true"`, or no filter at all would all have validated and then looped.
   *
   * Inverted, every one of those mistakes degrades to silence instead of a flood, and no
   * package has to remember anything to be safe. A subscriber that genuinely wants its own
   * echo — a live view confirming an optimistic update — asks for it deliberately.
   */
  readonly includeOwnMessages?: boolean;
}

/** What a subscriber declared: the thread it wants and the outbound method it implements. */
export interface SubscriptionDeclaration {
  readonly subscriberId: string;
  readonly threadId: string;
  readonly handleId: string;
  /** In-process packages expose their own action name; external runtimes keep the frozen row. */
  readonly method?: string;
  readonly lifecycleMethod?: string;
  /** Presentation contract the subscription declared (P1.3): both carry presentation; v2 also receipt line + replyTo. */
  readonly presentationVersion?: PresentationVersion;
  readonly filter?: SubscriptionFilter;
}

export type PresentationVersion = 'v1' | 'v2';

/** One lifecycle receiver on a thread, with the presentation contract its subscription declared. */
export interface LifecycleTarget {
  readonly subscriberId: string;
  readonly method: string;
  readonly wire: boolean;
  readonly presentationVersion?: PresentationVersion;
}

interface Registration {
  readonly subscriberId: string;
  readonly subscriptionId: string;
  readonly handleId: string;
  readonly method?: string;
  readonly lifecycleMethod?: string;
  readonly presentationVersion?: PresentationVersion;
  readonly filter?: SubscriptionFilter;
}

/** Raised when the log was trimmed past a subscriber's cursor (INV-9: surface, never skip). */
export class SubscriptionDeliveryStaleError extends Error {
  readonly subscriptionId: string;
  constructor(subscriptionId: string) {
    super(`subscription ${subscriptionId} fell behind the retained window — replay required`);
    this.name = 'SubscriptionDeliveryStaleError';
    this.subscriptionId = subscriptionId;
  }
}

export class SubscriptionDeliveryTimeoutError extends Error {
  readonly code = 'TIMEOUT';
  readonly status = 504;
  constructor() {
    super('delivery timed out');
    this.name = 'SubscriptionDeliveryTimeoutError';
  }
}

const DEFAULT_MAX_PAGES = 32;

/**
 * True when this subscriber authored the event and has not asked for its own echo. Only an
 * explicit `true` opts in, so a pocket key that is misspelled or carries a string falls through
 * to suppression — the safe side.
 */
function isUnwantedEcho(event: MessageOutputEvent, registration: Registration): boolean {
  if (registration.filter?.includeOwnMessages === true) return false;
  const actor = event.type === 'message.publish' ? event.envelope.actor : undefined;
  return actor?.kind === 'plugin' && actor.id === registration.subscriberId;
}

function isOwnEcho(event: MessageOutputEvent, registration: Registration): boolean {
  const actor = event.type === 'message.publish' ? event.envelope.actor : undefined;
  return actor?.kind === 'plugin' && actor.id === registration.subscriberId;
}

function deliveryMedia(event: Extract<MessageOutputEvent, { type: 'message.publish' }>): readonly {
  elementId: string;
  hmrId: string;
}[] {
  return event.envelope.payload.elements.flatMap((element) =>
    element.kind === 'media_ref' && element.payload.reference.startsWith('hmr_')
      ? [{ elementId: element.elementId, hmrId: element.payload.reference }]
      : [],
  );
}

function failureReason(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    if (error.code === 'TIMEOUT' || error.code === '504') return 'action_timeout';
    if (error.code === 'CANCELLED' || error.code === 'ABORT_ERR') return 'action_cancelled';
  }
  return 'action_failed';
}

function deliveryIdFor(registration: Registration, event: MessageOutputEvent): string {
  const digest = createHash('sha256')
    .update(registration.subscriberId)
    .update('\0')
    .update(registration.subscriptionId)
    .update('\0')
    .update(event.eventId)
    .digest('hex');
  return `delivery_${digest}`;
}

async function invokeDelivery(
  delivery: SubscriptionDeliveryDeps['delivery'],
  registration: Registration,
  event: Extract<MessageOutputEvent, { type: 'message.publish' }>,
  deliveryId: string,
  lifecycleId: string | undefined,
  presentation: DeliveryPresentationContext | undefined,
): Promise<void> {
  if (registration.method !== undefined) {
    if (!delivery.invoke) throw new Error('subscription delivery invocation port is unavailable');
    await delivery.invoke(registration.subscriberId, registration.method, {
      deliveryId,
      ...(lifecycleId === undefined ? {} : { lifecycleId }),
      ...(presentation === undefined ? {} : { presentation }),
      threadId: event.envelope.threadId,
      envelope: event.envelope,
    });
    return;
  }
  const input = {
    deliveryId,
    ...(lifecycleId === undefined ? {} : { lifecycleId }),
    ...(presentation === undefined ? {} : { presentation }),
    threadHandle: { kind: 'thread_handle' as const, handle: registration.handleId },
    envelope: event.envelope,
  };
  const receipt = await delivery.deliver(registration.subscriberId, input);
  if (receipt.deliveryId !== input.deliveryId) {
    throw new Error(`delivery receipt mismatch for ${input.deliveryId}`);
  }
}

async function waitForDeliveryAction(action: Promise<void>, signal: AbortSignal, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(Object.assign(new Error('delivery cancelled'), { code: 'CANCELLED' }));
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
        timer = setTimeout(() => reject(new SubscriptionDeliveryTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

async function deliverPublishedEvent(
  delivery: SubscriptionDeliveryDeps['delivery'],
  entitlements: SubscriptionDeliveryDeps['entitlements'],
  registration: Registration,
  event: MessageOutputEvent,
  signal: AbortSignal,
  timeoutMs: number,
  presentation: SubscriptionDeliveryDeps['presentation'],
  resolveInvocationId?: SubscriptionDeliveryDeps['resolveInvocationId'],
): Promise<void> {
  if (isUnwantedEcho(event, registration)) return;
  // The frozen callback row carries a complete envelope. Append events remain available
  // through explicit stream reads and must not be disguised as a different wire shape.
  if (event.type !== 'message.publish') return;

  const deliveryId = deliveryIdFor(registration, event);
  const invocationId = await resolveInvocationId?.(event.envelope.messageId);
  const lifecycleId =
    invocationId === undefined || !registration.lifecycleMethod ? undefined : lifecycleIdFor(invocationId);
  const deliveryPresentation =
    registration.presentationVersion === undefined
      ? undefined
      : await presentation(event.envelope.threadId, event.envelope.actor);
  const media = isOwnEcho(event, registration) ? [] : deliveryMedia(event);
  if (media.length > 0 && !entitlements) throw new Error('media entitlement service is unavailable');
  let reason = 'action_returned';
  try {
    if (signal.aborted) throw Object.assign(new Error('delivery cancelled'), { code: 'CANCELLED' });
    if (media.length > 0) {
      // One durable audit transaction precedes invocation; failure never exposes an unreadable hmr.
      await entitlements?.grantMany(
        media.map((element) => ({
          instanceId: registration.subscriberId,
          scope: { kind: 'delivery', deliveryId },
          elementId: element.elementId,
          hmrId: element.hmrId,
        })),
      );
      if (signal.aborted) throw Object.assign(new Error('delivery cancelled'), { code: 'CANCELLED' });
    }
    await waitForDeliveryAction(
      invokeDelivery(delivery, registration, event, deliveryId, lifecycleId, deliveryPresentation),
      signal,
      timeoutMs,
    );
  } catch (error) {
    reason = signal.aborted && typeof signal.reason === 'string' ? signal.reason : failureReason(error);
    throw error;
  } finally {
    // This must settle before the receipt/error is made observable to the caller.
    if (media.length > 0) await entitlements?.revoke({ scope: { kind: 'delivery', deliveryId } }, reason);
  }
}

export class SubscriptionDelivery {
  private readonly deps: SubscriptionDeliveryDeps;
  private readonly byThread = new Map<string, Registration[]>();
  private readonly drainTails = new Map<string, Promise<void>>();
  private readonly active = new Map<string, Set<{ controller: AbortController; done: Promise<void> }>>();
  private readonly stopped = new Set<string>();

  constructor(deps: SubscriptionDeliveryDeps) {
    this.deps = deps;
  }

  /** Idempotent: re-declaring the same handle reuses its subscription rather than doubling it. */
  async register(declaration: SubscriptionDeclaration): Promise<void> {
    this.stopped.delete(declaration.subscriberId);
    const ctx = { pluginInstanceId: declaration.subscriberId };
    const { subscriptionId } = await this.deps.messaging.subscribe(ctx, declaration.handleId);

    const existing = this.byThread.get(declaration.threadId) ?? [];
    const replacement: Registration = {
      subscriberId: declaration.subscriberId,
      subscriptionId,
      handleId: declaration.handleId,
      ...(declaration.method === undefined ? {} : { method: declaration.method }),
      ...(declaration.lifecycleMethod === undefined ? {} : { lifecycleMethod: declaration.lifecycleMethod }),
      ...(declaration.presentationVersion === undefined
        ? {}
        : { presentationVersion: declaration.presentationVersion }),
      ...(declaration.filter === undefined ? {} : { filter: declaration.filter }),
    };
    const index = existing.findIndex((entry) => entry.subscriberId === declaration.subscriberId);
    if (index === -1) existing.push(replacement);
    else existing[index] = replacement;
    this.byThread.set(declaration.threadId, existing);
  }

  unregister(subscriberId: string, threadId: string): void {
    const remaining = (this.byThread.get(threadId) ?? []).filter((entry) => entry.subscriberId !== subscriberId);
    if (remaining.length === 0) this.byThread.delete(threadId);
    else this.byThread.set(threadId, remaining);
  }

  /** Fence in-flight delivery before a carrier stop or uninstall becomes visible. */
  async cancelInstance(
    subscriberId: string,
    reason: 'instance_stopped' | 'instance_uninstalled' = 'instance_stopped',
  ): Promise<void> {
    this.stopped.add(subscriberId);
    for (const [threadId, registrations] of this.byThread) {
      const remaining = registrations.filter((registration) => registration.subscriberId !== subscriberId);
      if (remaining.length === 0) this.byThread.delete(threadId);
      else this.byThread.set(threadId, remaining);
    }
    const active = [...(this.active.get(subscriberId) ?? [])];
    for (const entry of active) entry.controller.abort(reason);
    await Promise.allSettled(active.map((entry) => entry.done));
    await this.deps.entitlements?.revoke({ instanceId: subscriberId }, reason);
  }

  /**
   * Deliver everything outstanding on this thread. Subscribers are independent: one sink being
   * down must not starve the others, so each is attempted and the first failure is surfaced only
   * after all of them have had their turn.
   */
  async drain(threadId: string): Promise<void> {
    await this.enqueueThread(threadId, () => this.drainSerial(threadId));
  }

  /** Lifecycle events and message delivery use one ordered tail per thread. */
  async enqueueThread(threadId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.drainTails.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.drainTails.set(threadId, current);
    try {
      await current;
    } finally {
      if (this.drainTails.get(threadId) === current) this.drainTails.delete(threadId);
    }
  }

  subscribersForThread(threadId: string): readonly string[] {
    return (this.byThread.get(threadId) ?? []).map((entry) => entry.subscriberId);
  }

  lifecycleTargetsForThread(threadId: string): readonly LifecycleTarget[] {
    return (this.byThread.get(threadId) ?? []).flatMap((entry) =>
      entry.lifecycleMethod
        ? [
            {
              subscriberId: entry.subscriberId,
              method: entry.method === undefined ? 'host.messaging.lifecycle' : entry.lifecycleMethod,
              wire: entry.method === undefined,
              ...(entry.presentationVersion === undefined ? {} : { presentationVersion: entry.presentationVersion }),
            },
          ]
        : [],
    );
  }

  private async drainSerial(threadId: string): Promise<void> {
    const registrations = this.byThread.get(threadId) ?? [];
    let failure: unknown;
    for (const registration of registrations) {
      try {
        await this.drainOne(registration);
      } catch (err) {
        this.deps.onError?.({
          subscriberId: registration.subscriberId,
          threadId,
          errorKind: err instanceof Error ? err.name : 'unknown',
        });
        if (failure === undefined) failure = err;
      }
    }
    if (failure !== undefined) throw failure;
  }

  private async drainOne(registration: Registration): Promise<void> {
    if (this.stopped.has(registration.subscriberId)) return;
    const ctx = { pluginInstanceId: registration.subscriberId };
    const maxPages = this.deps.maxPagesPerDrain ?? DEFAULT_MAX_PAGES;

    for (let page = 0; page < maxPages; page += 1) {
      const result = await this.deps.messaging.read(ctx, registration.subscriptionId, {
        ...(this.deps.readLimit === undefined ? {} : { limit: this.deps.readLimit }),
      });
      if (result.stale) throw new SubscriptionDeliveryStaleError(registration.subscriptionId);
      if (result.events.length === 0 || result.ackToken === null) return;

      // Ack covers the whole page, so every event in it must be accepted first. A throw here
      // leaves the cursor where it was and the page returns on the next drain. A filtered-out
      // event is still covered by that ack: skipping is a decision about this subscriber, not a
      // failure, and leaving it unacked would replay it forever.
      for (const event of result.events) {
        if (this.stopped.has(registration.subscriberId)) return;
        await this.deliverOne(registration, event);
      }
      await this.deps.messaging.ack(ctx, registration.subscriptionId, result.ackToken);
    }
  }

  private async deliverOne(registration: Registration, event: MessageOutputEvent): Promise<void> {
    const controller = new AbortController();
    const done = deliverPublishedEvent(
      this.deps.delivery,
      this.deps.entitlements,
      registration,
      event,
      controller.signal,
      this.deps.actionTimeoutMs ?? 30_000,
      this.deps.presentation,
      this.deps.resolveInvocationId,
    );
    const entry = { controller, done };
    const active = this.active.get(registration.subscriberId) ?? new Set<typeof entry>();
    active.add(entry);
    this.active.set(registration.subscriberId, active);
    try {
      await done;
    } finally {
      active.delete(entry);
      if (active.size === 0) this.active.delete(registration.subscriberId);
    }
  }
}

export function createSubscriptionDelivery(deps: SubscriptionDeliveryDeps): SubscriptionDelivery {
  return new SubscriptionDelivery(deps);
}
