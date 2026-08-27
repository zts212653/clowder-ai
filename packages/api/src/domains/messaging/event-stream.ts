/**
 * Plugin Messaging — event stream subscriptions (K-1 / F288, AC-3, §4b)
 *
 * Cursor scope = (pluginInstanceId × subscription); ack cursors are durable.
 * Delivery = at-least-once for unacked events (INV-4); consumers dedupe by
 * eventId. The ack token is subscription-local and opaque (INV-5) — v0
 * opacity is contractual, enforcement is server-side subscription matching
 * plus the delivered watermark (the guard, not the token, is load-bearing;
 * cryptographic tokens are a F288 non-goal until K-2's untrusted transport).
 *
 * Stale (INV-9): cursor behind the retention floor → read returns
 * { stale: true } with zero events; snapshot() catches up from the message
 * store (pure projection) and resets the cursor to head. Acks of previously
 * delivered events stay valid across trims — they can cure staleness, never
 * cause silent skips (events ≤ acked sequence were delivered pre-trim).
 *
 * Subscribe idempotency: the (instance, handle) slot is won atomically via
 * CursorStore.createOrGet — concurrent subscribes converge on one
 * live cursor. After the claim the handle is re-checked so a revocation
 * cascade racing the subscribe cannot leave a live orphan (fail-closed with
 * HandleService.revoke's cascade-first ordering).
 *
 * v0 subscription binds ONE thread handle (D-2): cross-thread cursor misuse
 * is impossible by construction.
 */

import { randomUUID } from 'node:crypto';
import {
  type M0CSnapshotInput,
  type M0CSnapshotResult,
  type MessageOutputEvent,
  validateMessagingRowInput,
} from '@clowder-ai/plugin-contract';
import type { IMessageStore } from '../cats/services/stores/ports/MessageStore.js';
import type { PluginCallContext, ReadResult, SnapshotResult, SubscribeResult } from './contract/host-types.js';
import { MessagingError, SnapshotUnavailableHostError } from './contract/host-types.js';
import type { HandleService } from './handles.js';
import { SnapshotCaptureCoordinator } from './snapshot-capture.js';
import { assembleSnapshotPage, resultFits } from './snapshot-page-assembly.js';
import { decodeSnapshotPageToken, encodeSnapshotAckToken, encodeSnapshotPageToken } from './snapshot-tokens.js';
import type { CursorStore, EventLogStore, SnapshotViewRecord, SubscriptionRecord } from './stores/ports.js';

export const DEFAULT_READ_LIMIT = 32;
export const MAX_READ_LIMIT = 32;

export interface EventStreamDeps {
  readonly events: EventLogStore;
  readonly cursors: CursorStore;
  readonly handles: HandleService;
  readonly messageStore: IMessageStore;
}

interface AckTokenPayload {
  readonly s: string;
  readonly q: number;
  readonly n: string;
  readonly k?: 'snapshot';
}

function encodeAckToken(subscriptionId: string, sequence: number): string {
  const payload: AckTokenPayload = { s: subscriptionId, q: sequence, n: randomUUID().slice(0, 8) };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeAckToken(token: string): AckTokenPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw new MessagingError('VALIDATION', 'malformed ack token');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).s !== 'string' ||
    typeof (parsed as Record<string, unknown>).n !== 'string' ||
    typeof (parsed as Record<string, unknown>).q !== 'number' ||
    !Number.isInteger((parsed as Record<string, unknown>).q) ||
    ((parsed as Record<string, unknown>).k !== undefined && (parsed as Record<string, unknown>).k !== 'snapshot')
  ) {
    throw new MessagingError('VALIDATION', 'malformed ack token');
  }
  return parsed as unknown as AckTokenPayload;
}

function assembleReadResult(subscriptionId: string, events: readonly MessageOutputEvent[]): ReadResult {
  for (let count = events.length; count >= 1; count -= 1) {
    const page = events.slice(0, count);
    const last = page[page.length - 1];
    if (!last) continue;
    const result: ReadResult = {
      events: page,
      ackToken: encodeAckToken(subscriptionId, last.sequence),
      stale: false,
    };
    if (resultFits('messaging.read', result)) return result;
  }
  throw new Error('messaging.read cannot encode one valid event within the published result budget');
}

export class EventStreamService {
  private readonly deps: EventStreamDeps;
  private readonly snapshots: SnapshotCaptureCoordinator;

  constructor(deps: EventStreamDeps) {
    this.deps = deps;
    this.snapshots = new SnapshotCaptureCoordinator(deps);
  }

  async subscribe(ctx: PluginCallContext, handleId: string): Promise<SubscribeResult> {
    const handle = await this.deps.handles.resolveForSubscribe(ctx.pluginInstanceId, handleId);
    const existing = await this.deps.cursors.findByHandle(ctx.pluginInstanceId, handleId);
    if (existing) return { subscriptionId: existing.subscriptionId };

    const head = await this.deps.events.headSequence(handle.threadId);
    const record: SubscriptionRecord = {
      subscriptionId: `sub_${randomUUID()}`,
      pluginInstanceId: ctx.pluginInstanceId,
      handleId,
      threadId: handle.threadId,
      ackedSequence: head,
      lastDeliveredSequence: head,
    };
    const winner = await this.deps.cursors.createOrGet(record);

    // Close the subscribe-vs-revocation race: if the handle was revoked while
    // we were writing, revoke what we just created instead of leaking a live
    // subscription on a dead handle.
    try {
      await this.deps.handles.resolveForSubscribe(ctx.pluginInstanceId, handleId);
    } catch (err) {
      await this.deps.cursors.revokeByHandle(handleId, Date.now());
      throw err;
    }

    return { subscriptionId: winner.subscriptionId };
  }

  /** Common gate: existence (instance-scoped lookup) → liveness. */
  private async requireLiveSubscription(ctx: PluginCallContext, subscriptionId: string): Promise<SubscriptionRecord> {
    const sub = await this.deps.cursors.get(ctx.pluginInstanceId, subscriptionId);
    if (!sub) throw new MessagingError('NOT_FOUND', `unknown subscription ${subscriptionId}`);
    if (sub.revokedAt !== undefined) {
      throw new MessagingError('PERMISSION', 'subscription revoked (handle revocation cascade)');
    }
    // The cascade is an optimization, not the authority. Re-checking the
    // handle closes crash/race windows between HandleStore.revoke and cursor
    // fan-out, so a dead handle can never retain a readable subscription.
    await this.deps.handles.resolveForSubscribe(ctx.pluginInstanceId, sub.handleId);
    return sub;
  }

  async read(ctx: PluginCallContext, subscriptionId: string, options: { limit?: number }): Promise<ReadResult> {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1)) {
      throw new MessagingError('VALIDATION', 'limit must be a positive integer when present');
    }
    const sub = await this.requireLiveSubscription(ctx, subscriptionId);
    const limit = Math.min(options.limit ?? DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
    // Read first, then inspect the retention floor. If a concurrent append
    // trims between the two calls, the newer floor makes us return stale. The
    // inverse order can observe an old floor followed by a trimmed page and
    // silently skip the removed events.
    const events = await this.deps.events.readAfter(sub.threadId, sub.ackedSequence, limit);
    const floor = await this.deps.events.minSequence(sub.threadId);
    if (floor !== null && sub.ackedSequence < floor - 1) {
      return { events: [], ackToken: null, stale: true }; // INV-9: surface, never skip
    }
    if (events.length === 0) return { events: [], ackToken: null, stale: false };
    const result = assembleReadResult(subscriptionId, events);
    const last = result.events[result.events.length - 1];
    const lastSequence = last ? last.sequence : sub.ackedSequence;
    await this.deps.cursors.advanceDelivered(ctx.pluginInstanceId, subscriptionId, lastSequence);
    return result;
  }

  async ack(ctx: PluginCallContext, subscriptionId: string, token: string): Promise<void> {
    const sub = await this.requireLiveSubscription(ctx, subscriptionId);
    const payload = decodeAckToken(token);
    if (payload.s !== subscriptionId) {
      throw new MessagingError('VALIDATION', 'ack token belongs to a different subscription (INV-5)');
    }
    if (payload.k === 'snapshot') {
      const outcome = await this.deps.cursors.ackSnapshot(ctx.pluginInstanceId, subscriptionId, payload.n, payload.q);
      if (outcome === 'rejected') {
        throw new MessagingError('PERMISSION', 'snapshot ack token is not an active entitlement');
      }
      return;
    }
    if (payload.q > sub.lastDeliveredSequence) {
      throw new MessagingError('PERMISSION', 'ack token sequence exceeds delivered watermark');
    }
    await this.deps.cursors.advanceAck(ctx.pluginInstanceId, subscriptionId, payload.q);
  }

  /**
   * Catch-up path (INV-9): project the recent public message window to
   * envelopes and reset the cursor to the current head. Window size documents
   * the same retention philosophy as the event log.
   */
  async snapshot(ctx: PluginCallContext, subscriptionId: string): Promise<SnapshotResult> {
    const sub = await this.requireLiveSubscription(ctx, subscriptionId);
    const captured = await this.snapshots.captureInMemory(sub);
    await this.deps.cursors.advanceDelivered(ctx.pluginInstanceId, subscriptionId, captured.headSequence);
    await this.deps.cursors.advanceAck(ctx.pluginInstanceId, subscriptionId, captured.headSequence);
    return { envelopes: captured.items, resumeSequence: captured.headSequence };
  }

  async snapshotPage(ctx: PluginCallContext, input: M0CSnapshotInput): Promise<M0CSnapshotResult> {
    const validation = validateMessagingRowInput('messaging.snapshot', input);
    if (!validation.valid) throw new MessagingError('VALIDATION', 'invalid snapshot page request');
    const parsed = validation.value;
    const sub = await this.requireLiveSubscription(ctx, parsed.subscriptionId);
    const resolved = await this.resolveSnapshotView(ctx, parsed, sub);
    if (resolved.replay) return this.replaySnapshotPage(ctx, parsed.subscriptionId, resolved.snapshot);

    const { snapshot, offset, pageTokenId } = resolved;
    if (offset > snapshot.itemCount) throw new SnapshotUnavailableHostError('VIEW_EXPIRED');
    const requestedCount = Math.min(parsed.maxItems, snapshot.itemCount - offset);
    const availableItems = await this.readFrozenPage(ctx, parsed.subscriptionId, snapshot, offset, requestedCount);
    const assembled = assembleSnapshotPage(parsed.subscriptionId, snapshot, offset, availableItems);
    let consumed: boolean;
    try {
      consumed = await this.deps.cursors.consumeSnapshotPage(
        ctx.pluginInstanceId,
        parsed.subscriptionId,
        snapshot.snapshotId,
        { offset, ...(pageTokenId === undefined ? {} : { tokenId: pageTokenId }) },
        {
          offset: assembled.nextOffset,
          ...(assembled.nextPageTokenId === undefined ? {} : { tokenId: assembled.nextPageTokenId }),
          traversalComplete: assembled.traversalComplete,
        },
      );
    } catch {
      throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
    }
    if (!consumed) throw new SnapshotUnavailableHostError('VIEW_EXPIRED');
    return assembled.result;
  }

  private async replaySnapshotPage(
    ctx: PluginCallContext,
    subscriptionId: string,
    snapshot: SnapshotViewRecord,
  ): Promise<M0CSnapshotResult> {
    const offset = snapshot.lastPageOffset;
    if (offset === undefined || offset > snapshot.nextOffset) {
      throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
    }
    const items = await this.readFrozenPage(ctx, subscriptionId, snapshot, offset, snapshot.nextOffset - offset);
    let result: M0CSnapshotResult;
    if (snapshot.traversalComplete) {
      result = {
        items,
        nextPageToken: null,
        snapshotAckToken: encodeSnapshotAckToken(subscriptionId, snapshot),
      };
    } else {
      if (snapshot.nextPageTokenId === undefined) {
        throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
      }
      result = {
        items,
        nextPageToken: encodeSnapshotPageToken(
          subscriptionId,
          snapshot.snapshotId,
          snapshot.nextOffset,
          snapshot.nextPageTokenId,
        ),
        snapshotAckToken: null,
      };
    }
    if (!resultFits('messaging.snapshot', result)) {
      throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
    }
    return result;
  }

  private async readFrozenPage(
    ctx: PluginCallContext,
    subscriptionId: string,
    snapshot: SnapshotViewRecord,
    offset: number,
    count: number,
  ): Promise<M0CSnapshotResult['items']> {
    try {
      const items = await this.deps.cursors.readSnapshotPage(
        ctx.pluginInstanceId,
        subscriptionId,
        snapshot.snapshotId,
        offset,
        count,
      );
      if (!items || items.length !== count) throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
      return structuredClone(items);
    } catch (error) {
      if (error instanceof SnapshotUnavailableHostError) throw error;
      throw new SnapshotUnavailableHostError('STORE_UNAVAILABLE');
    }
  }

  private async resolveSnapshotView(
    ctx: PluginCallContext,
    input: M0CSnapshotInput,
    sub: SubscriptionRecord,
  ): Promise<
    | { snapshot: SnapshotViewRecord; offset: number; pageTokenId?: string; replay?: false }
    | { snapshot: SnapshotViewRecord; replay: true }
  > {
    if (input.pageToken !== undefined) {
      const token = decodeSnapshotPageToken(input.pageToken);
      if (token.s !== input.subscriptionId) {
        throw new MessagingError('PERMISSION', 'snapshot page token belongs to a different subscription');
      }
      if (!sub.snapshotView || sub.snapshotView.snapshotId !== token.v) {
        throw new SnapshotUnavailableHostError('VIEW_EXPIRED');
      }
      return { snapshot: sub.snapshotView, offset: token.o, pageTokenId: token.n };
    }
    if (sub.snapshotView) {
      return sub.snapshotView.lastPageOffset === undefined
        ? { snapshot: sub.snapshotView, offset: 0 }
        : { snapshot: sub.snapshotView, replay: true };
    }

    const snapshot = await this.snapshots.captureView(ctx, sub);
    return snapshot.lastPageOffset === undefined ? { snapshot, offset: 0 } : { snapshot, replay: true };
  }
}
