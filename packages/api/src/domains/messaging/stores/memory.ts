/**
 * Plugin Messaging — in-memory store implementations (K-1 / F288)
 *
 * Dev/test semantics: process-lifetime state (consistent with the in-memory
 * MessageStore — KL-2 in the plan). Redis implementations carry production
 * durability. Atomicity: single-threaded event loop makes check-then-act
 * inside one synchronous block atomic.
 */

import { randomUUID } from 'node:crypto';
import type { MessageOutputEvent } from '@clowder-ai/plugin-contract';
import type { HandleScope, MessageOutputEventInput } from '../contract/host-types.js';
import type {
  AppendLease,
  AppendLock,
  EventLogAppendResult,
  EventLogStore,
  HandleRecord,
  HandleStore,
  LedgerClaimResult,
  LedgerStore,
  MessageHandleRecord,
  SettleResult,
} from './ports.js';

export { MemoryCursorStore } from './memory-cursor.js';

/** Deep-clone scope so callers cannot mutate stored authority (INV-22 parity). */
function cloneScope(scope: HandleScope): HandleScope {
  return {
    canSend: scope.canSend,
    canSubscribe: scope.canSubscribe,
    ...(scope.allowedWhisperTargets ? { allowedWhisperTargets: [...scope.allowedWhisperTargets] } : {}),
  };
}

type LedgerEntry =
  | { readonly status: 'inflight'; readonly claimToken: string; readonly expiresAt: number }
  | { readonly status: 'settled'; readonly receipt: unknown; readonly expiresAt: number };

export class MemoryLedgerStore implements LedgerStore {
  private readonly entries = new Map<string, LedgerEntry>();

  async claim(key: string, claimTtlMs: number): Promise<LedgerClaimResult> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > now) {
      if (entry.status === 'settled') return { status: 'settled', receipt: entry.receipt };
      return { status: 'inflight' };
    }
    const claimToken = randomUUID();
    this.entries.set(key, { status: 'inflight', claimToken, expiresAt: now + claimTtlMs });
    return { status: 'new', claimToken };
  }

  async settle(key: string, claimToken: string, receipt: unknown, retentionMs: number): Promise<SettleResult> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (entry && entry.status === 'settled' && entry.expiresAt > now)
      return { status: 'already_settled', receipt: entry.receipt };
    if (!entry || entry.status !== 'inflight' || entry.expiresAt <= now || entry.claimToken !== claimToken)
      return { status: 'rejected' };
    this.entries.set(key, { status: 'settled', receipt, expiresAt: now + retentionMs });
    return { status: 'freshly_settled' };
  }

  async release(key: string, claimToken: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry || entry.status === 'settled') return; // settled is sticky
    if (entry.claimToken !== claimToken) return;
    this.entries.delete(key);
  }
}

export class MemoryHandleStore implements HandleStore {
  private readonly records = new Map<string, HandleRecord>();
  /** Secondary index: messageId → opaque handleId (ensureMessageHandle idempotency). */
  private readonly messageIndex = new Map<string, string>();

  async put(record: HandleRecord): Promise<void> {
    // Defensive copy: prevent caller mutations from corrupting the store
    // (INV-22 parity — Redis serializes on write; Memory must snapshot too).
    this.records.set(record.handleId, { ...record, scope: cloneScope(record.scope) });
  }

  async get(handleId: string): Promise<HandleRecord | null> {
    return this.records.get(handleId) ?? null;
  }

  /**
   * Synchronous critical section: check + write with no awaits between,
   * so the single-threaded event loop guarantees atomicity. A concurrent
   * `Promise.all` of two `getOrCreateMessageHandle` calls for the same
   * messageId converges on one canonical record.
   *
   * Validates the full immutable binding tuple (INV-21: kind, messageId,
   * pluginInstanceId, parentHandleId, threadId, userId) before returning
   * any indexed record. Any field mismatch fails closed (throws). Wrong
   * kind (INV-23) also throws rather than falling through to create.
   */
  async getOrCreateMessageHandle(
    record: MessageHandleRecord,
  ): Promise<{ record: MessageHandleRecord; created: boolean }> {
    const existingId = this.messageIndex.get(record.messageId);
    if (existingId) {
      const existing = this.records.get(existingId);
      if (existing) {
        // INV-23: wrong kind → fail closed, not fall-through to create
        if (existing.kind !== 'message_handle') {
          throw new Error(
            `handle index corruption: indexed record ${existing.handleId} ` +
              `has kind=${existing.kind}, expected message_handle`,
          );
        }
        // INV-21: full immutable binding validation before return
        if (existing.messageId !== record.messageId) {
          throw new Error(
            `handle index corruption: indexed record ${existing.handleId} has ` +
              `messageId=${existing.messageId}, requested=${record.messageId}`,
          );
        }
        if (existing.pluginInstanceId !== record.pluginInstanceId) {
          throw new Error(
            `handle binding violation: pluginInstanceId ` +
              `existing=${existing.pluginInstanceId}, requested=${record.pluginInstanceId}`,
          );
        }
        if (existing.parentHandleId !== record.parentHandleId) {
          throw new Error(
            `handle binding violation: parentHandleId ` +
              `existing=${existing.parentHandleId}, requested=${record.parentHandleId}`,
          );
        }
        if (existing.threadId !== record.threadId) {
          throw new Error(
            `handle binding violation: threadId existing=${existing.threadId}, requested=${record.threadId}`,
          );
        }
        if (existing.userId !== record.userId) {
          throw new Error(`handle binding violation: userId existing=${existing.userId}, requested=${record.userId}`);
        }
        return { record: existing, created: false };
      }
    }
    // M8/M9: index miss or record missing → create new record
    // Defensive copy (INV-22 parity — Redis serializes; Memory must snapshot).
    const snapshot = { ...record, scope: cloneScope(record.scope) };
    this.records.set(snapshot.handleId, snapshot);
    this.messageIndex.set(snapshot.messageId, snapshot.handleId);
    return { record: snapshot, created: true };
  }

  async revoke(handleId: string, revokedAt: number): Promise<boolean> {
    const record = this.records.get(handleId);
    if (!record) return false;
    if (record.revokedAt === undefined) {
      this.records.set(handleId, { ...record, revokedAt });
    }
    return true;
  }
}

interface ThreadLog {
  head: number;
  events: Array<{ readonly key: string; readonly event: MessageOutputEvent }>;
}

export class MemoryEventLogStore implements EventLogStore {
  private readonly threads = new Map<string, ThreadLog>();

  private logFor(threadId: string): ThreadLog {
    let log = this.threads.get(threadId);
    if (!log) {
      log = { head: 0, events: [] };
      this.threads.set(threadId, log);
    }
    return log;
  }

  async append(
    threadId: string,
    eventKey: string,
    event: MessageOutputEventInput,
    retentionCount: number,
    lease?: AppendLease,
  ): Promise<EventLogAppendResult> {
    if (lease !== undefined) {
      const messageId = event.type === 'message.publish' ? event.envelope.messageId : event.messageId;
      if (lease.messageId !== messageId || lease.isCurrent?.() !== true) {
        return { deduped: false, fencedOut: true };
      }
    }
    const log = this.logFor(threadId);
    const existing = log.events.find((entry) => entry.key === eventKey);
    if (existing) return { sequence: existing.event.sequence, deduped: true, fencedOut: false };
    log.head += 1;
    log.events.push({ key: eventKey, event: { ...event, sequence: log.head } as MessageOutputEvent });
    if (log.events.length > retentionCount) {
      log.events.splice(0, log.events.length - retentionCount);
    }
    return { sequence: log.head, deduped: false, fencedOut: false };
  }

  async readAfter(threadId: string, afterSequence: number, limit: number): Promise<MessageOutputEvent[]> {
    const log = this.threads.get(threadId);
    if (!log) return [];
    const matches: MessageOutputEvent[] = [];
    for (const entry of log.events) {
      if (entry.event.sequence <= afterSequence) continue;
      matches.push(entry.event);
      if (matches.length >= limit) break;
    }
    return matches;
  }

  async minSequence(threadId: string): Promise<number | null> {
    const log = this.threads.get(threadId);
    return log && log.events.length > 0 ? (log.events[0]?.event.sequence ?? null) : null;
  }

  async headSequence(threadId: string): Promise<number> {
    return this.threads.get(threadId)?.head ?? 0;
  }
}

export class MemoryAppendLock implements AppendLock {
  private readonly locks = new Map<string, { token: string; expiresAt: number }>();

  async acquire(messageId: string, ttlMs: number): Promise<AppendLease | null> {
    const now = Date.now();
    const current = this.locks.get(messageId);
    if (current !== undefined && current.expiresAt > now) return null;
    const token = randomUUID();
    this.locks.set(messageId, { token, expiresAt: now + ttlMs });
    return {
      messageId,
      token,
      isCurrent: () => {
        const live = this.locks.get(messageId);
        return live?.token === token && live.expiresAt > Date.now();
      },
    };
  }

  async release(messageId: string, lease: AppendLease): Promise<void> {
    if (lease.messageId === messageId && this.locks.get(messageId)?.token === lease.token) {
      this.locks.delete(messageId);
    }
  }
}
