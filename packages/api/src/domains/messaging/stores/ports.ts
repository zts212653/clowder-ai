/**
 * Plugin Messaging — store ports (K-1 / F288)
 *
 * Small persistence seams behind the messaging domain services.
 * Two implementations each: memory (dev, process-lifetime — consistent with
 * MessageStore semantics) and Redis (production, plugmsg:* namespace).
 * Lifecycle owners: §4 of the implementation plan — services own state
 * machines; stores only persist. No bypass APIs (no generic list/delete).
 */

import type { MessageEnvelope, MessageOutputEvent } from '@clowder-ai/plugin-contract';
import type { HandleScope, MessageOutputEventInput } from '../contract/host-types.js';

/** Single source for the per-thread event log trim depth (send/append/facade all import this). */
export const DEFAULT_EVENT_RETENTION = 500;

/** Fail-closed floor: a retention below 1 would trim a just-appended event (self-destructing log). */
export function clampRetention(retentionCount: number | undefined): number {
  if (retentionCount === undefined || !Number.isFinite(retentionCount)) return DEFAULT_EVENT_RETENTION;
  return Math.max(1, Math.trunc(retentionCount));
}

// ── Ledger (owner: MessagingLedger, §4a) ──

export type LedgerClaimResult =
  | { readonly status: 'new'; readonly claimToken: string }
  | { readonly status: 'inflight' }
  | { readonly status: 'settled'; readonly receipt: unknown };

/** Discriminated settlement outcome — preserves whether the caller's receipt or
 *  a predecessor's canonical receipt won the race. */
export type SettleResult =
  | { readonly status: 'freshly_settled' }
  | { readonly status: 'already_settled'; readonly receipt: unknown }
  | { readonly status: 'rejected' };

export interface LedgerStore {
  /** Atomic: unclaimed → inflight (returns new); inflight → inflight; settled → settled+receipt. */
  claim(key: string, claimTtlMs: number): Promise<LedgerClaimResult>;
  /** inflight → settled. Returns a discriminated outcome:
   *  - `freshly_settled`: this call committed the receipt.
   *  - `already_settled`: a predecessor already committed; `.receipt` is theirs.
   *  - `rejected`: claimToken stale/expired/mismatched. */
  settle(key: string, claimToken: string, receipt: unknown, retentionMs: number): Promise<SettleResult>;
  /** inflight → unclaimed (failure path; no-op when settled). */
  release(key: string, claimToken: string): Promise<void>;
}

// ── Handles (owner: HandleService, §4c) ──

interface HandleRecordBase {
  readonly handleId: string;
  readonly pluginInstanceId: string;
  readonly threadId: string;
  /** Thread owner bound at issuance — used as StoredMessage.userId. */
  readonly userId: string;
  readonly scope: HandleScope;
  readonly issuedAt: number;
  readonly revokedAt?: number;
}

export interface AddressHandleRecord extends HandleRecordBase {
  readonly kind: 'thread_handle' | 'connector_binding';
  readonly connectorBinding?: { readonly connectorId: string; readonly externalChatId: string };
}

export interface MessageHandleRecord extends HandleRecordBase {
  readonly kind: 'message_handle';
  readonly messageId: string;
  readonly parentHandleId: string;
}

export type HandleRecord = AddressHandleRecord | MessageHandleRecord;

export interface HandleStore {
  put(record: HandleRecord): Promise<void>;
  get(handleId: string): Promise<HandleRecord | null>;
  /**
   * Atomic get-or-create for message handles. Returns the existing handle if
   * one is already minted for `record.messageId`; otherwise persists `record`
   * and its reverse index in one atomic step (Memory: synchronous critical
   * section; Redis: Lua script). `created` is true only when a new record was
   * written.
   */
  getOrCreateMessageHandle(record: MessageHandleRecord): Promise<{ record: MessageHandleRecord; created: boolean }>;
  /** active → revoked (idempotent). Returns false when the handle does not exist. */
  revoke(handleId: string, revokedAt: number): Promise<boolean>;
}

// ── Event log + per-thread sequence (owner: EventStreamService, §4b) ──

export interface EventLogAppendResult {
  /** Absent only when a stale append lease was atomically fenced out. */
  readonly sequence?: number;
  /** True when the deterministic eventKey was already present (crash-retry dedupe, D-3). */
  readonly deduped: boolean;
  /** True means lease validation failed and the event log was not mutated. */
  readonly fencedOut: boolean;
}

/**
 * Opaque capability returned by AppendLock. Redis validates token ownership
 * inside the event-append Lua script; memory uses isCurrent in the same
 * synchronous critical section as its array append.
 */
export interface AppendLease {
  readonly messageId: string;
  readonly token: string;
  readonly isCurrent?: () => boolean;
}

export interface EventLogStore {
  /**
   * Atomically: dedupe by eventKey within the retained window → assign next
   * per-thread sequence → append → trim to retentionCount (INV-3 monotonic).
   * The submitted event carries no sequence — the store assigns it and the
   * read path returns events with their assigned sequence.
   */
  append(
    threadId: string,
    eventKey: string,
    event: MessageOutputEventInput,
    retentionCount: number,
    lease?: AppendLease,
  ): Promise<EventLogAppendResult>;
  /** Events with sequence > afterSequence, ascending, at most limit. */
  readAfter(threadId: string, afterSequence: number, limit: number): Promise<MessageOutputEvent[]>;
  /** Smallest retained sequence (retention floor projection); null when log is empty. */
  minSequence(threadId: string): Promise<number | null>;
  /** Highest assigned sequence (counter value); 0 when no event was ever assigned. */
  headSequence(threadId: string): Promise<number>;
}

// ── Subscriptions + durable ack cursor (owner: EventStreamService, §4b) ──

export interface SubscriptionRecord {
  readonly subscriptionId: string;
  readonly pluginInstanceId: string;
  readonly handleId: string;
  readonly threadId: string;
  /** Durable ack cursor: last acked sequence. */
  readonly ackedSequence: number;
  /** Highest sequence handed out by read() — bounds valid ack tokens. */
  readonly lastDeliveredSequence: number;
  /** Frozen M0-C snapshot projection, stored beside the authoritative cursor. */
  readonly snapshotView?: SnapshotViewRecord;
  /** Last consumed entitlement retained solely to make ack retries idempotent. */
  readonly lastSnapshotCompletion?: SnapshotCompletionRecord;
  readonly revokedAt?: number;
}

export interface SnapshotViewRecord {
  readonly snapshotId: string;
  readonly headSequence: number;
  /** Frozen item count; payload rows live in page-addressable storage. */
  readonly itemCount: number;
  readonly createdAt: number;
  /** Exact next page entitlement; undefined only for the initial page. */
  readonly nextPageTokenId?: string;
  readonly nextOffset: number;
  /** Start offset of the last committed page, retained for response replay. */
  readonly lastPageOffset?: number;
  /** Final ack is invalid until every frozen page has been consumed. */
  readonly traversalComplete: boolean;
}

/** Unpublished capture lease. Partial rows are never visible to readers. */
export interface SnapshotCaptureCandidate {
  readonly snapshotId: string;
  readonly headSequence: number;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export type SnapshotCaptureStart =
  | { readonly status: 'started' }
  | { readonly status: 'busy' }
  | { readonly status: 'existing'; readonly snapshot: SnapshotViewRecord };

export interface SnapshotCaptureCommit {
  readonly snapshotId: string;
  readonly expectedItemCount: number;
  readonly nextOffset: number;
  readonly traversalComplete: boolean;
}

export interface SnapshotCompletionRecord {
  readonly snapshotId: string;
  readonly headSequence: number;
}

export interface CursorStore {
  put(record: SubscriptionRecord): Promise<void>;
  get(pluginInstanceId: string, subscriptionId: string): Promise<SubscriptionRecord | null>;
  /** Subscribe idempotency: existing live subscription for (instance, handle). */
  findByHandle(pluginInstanceId: string, handleId: string): Promise<SubscriptionRecord | null>;
  /** Monotonic max advance of ackedSequence. */
  advanceAck(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void>;
  /** Monotonic max advance of lastDeliveredSequence. */
  advanceDelivered(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void>;
  /** Claim a restart-safe unpublished capture slot, or return the committed view. */
  beginSnapshotCapture(
    pluginInstanceId: string,
    subscriptionId: string,
    capture: SnapshotCaptureCandidate,
  ): Promise<SnapshotCaptureStart | null>;
  /** Append one bounded chunk at the exact staged offset. */
  appendSnapshotCapture(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    expectedOffset: number,
    items: readonly MessageEnvelope[],
  ): Promise<boolean>;
  /** Atomically publish a fully staged capture as the active frozen view. */
  commitSnapshotCapture(
    pluginInstanceId: string,
    subscriptionId: string,
    capture: SnapshotCaptureCommit,
  ): Promise<SnapshotViewRecord | null>;
  /** Discard only the named unpublished capture; committed state is untouched. */
  abortSnapshotCapture(pluginInstanceId: string, subscriptionId: string, snapshotId: string): Promise<void>;
  /** Read only the requested frozen page; null means the view is unavailable. */
  readSnapshotPage(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    offset: number,
    limit: number,
  ): Promise<readonly MessageEnvelope[] | null>;
  /** Consume exactly one issued page entitlement and publish its successor atomically. */
  consumeSnapshotPage(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    expected: { readonly offset: number; readonly tokenId?: string },
    next: { readonly offset: number; readonly tokenId?: string; readonly traversalComplete: boolean },
  ): Promise<boolean>;
  /**
   * Consume the final snapshot entitlement atomically: validate the exact
   * frozen view, max-advance ack+delivered together, and retain a replay marker.
   */
  ackSnapshot(
    pluginInstanceId: string,
    subscriptionId: string,
    snapshotId: string,
    headSequence: number,
  ): Promise<'applied' | 'replayed' | 'rejected'>;
  /**
   * Atomically create a subscription and its (instance, handle) index, or
   * return the existing live record. No partially-indexed record is exposed.
   */
  createOrGet(record: SubscriptionRecord): Promise<SubscriptionRecord>;
  /** Handle revocation cascade (§4c): revoke every subscription bound to the handle. */
  revokeByHandle(handleId: string, revokedAt: number): Promise<number>;
}

// ── Append lock (owner: AppendService, §4d) ──

export interface AppendLock {
  /**
   * Best-effort per-message mutex with TTL. Returns an owner token when
   * acquired, null when contended. release() frees the lock ONLY when the
   * token still owns it — a stale holder (TTL takeover) can never free a
   * successor's lock (same guarantee in memory and Redis impls).
   */
  acquire(messageId: string, ttlMs: number): Promise<AppendLease | null>;
  release(messageId: string, lease: AppendLease): Promise<void>;
}

export interface MessagingStores {
  readonly ledger: LedgerStore;
  readonly handles: HandleStore;
  readonly events: EventLogStore;
  readonly cursors: CursorStore;
  readonly appendLock: AppendLock;
}
