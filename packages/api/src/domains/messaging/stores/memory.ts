/**
 * Plugin Messaging — in-memory store implementations (K-1 / F258)
 *
 * Dev/test semantics: process-lifetime state (consistent with the in-memory
 * MessageStore — KL-2 in the plan). Redis implementations carry production
 * durability. Atomicity: single-threaded event loop makes check-then-act
 * inside one synchronous block atomic.
 */

import { randomUUID } from 'node:crypto';
import type { MessageOutputEvent } from '@clowder-ai/plugin-contract';
import type { MessageOutputEventInput } from '../contract/host-types.js';
import type {
  AppendLease,
  AppendLock,
  CursorStore,
  EventLogAppendResult,
  EventLogStore,
  HandleRecord,
  HandleStore,
  LedgerClaimResult,
  LedgerStore,
  SubscriptionRecord,
} from './ports.js';

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

  async settle(key: string, claimToken: string, receipt: unknown, retentionMs: number): Promise<void> {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (entry && entry.status === 'settled' && entry.expiresAt > now) return; // first receipt sticks
    if (!entry || entry.status !== 'inflight' || entry.expiresAt <= now || entry.claimToken !== claimToken) return;
    this.entries.set(key, { status: 'settled', receipt, expiresAt: now + retentionMs });
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

  async put(record: HandleRecord): Promise<void> {
    this.records.set(record.handleId, record);
  }

  async get(handleId: string): Promise<HandleRecord | null> {
    return this.records.get(handleId) ?? null;
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

export class MemoryCursorStore implements CursorStore {
  private readonly subs = new Map<string, SubscriptionRecord>();
  private readonly subscriptionByHandle = new Map<string, string>();

  private static key(pluginInstanceId: string, subscriptionId: string): string {
    return `${encodeURIComponent(pluginInstanceId)}:${encodeURIComponent(subscriptionId)}`;
  }

  private static handleKey(pluginInstanceId: string, handleId: string): string {
    return `${encodeURIComponent(pluginInstanceId)}:${encodeURIComponent(handleId)}`;
  }

  async put(record: SubscriptionRecord): Promise<void> {
    this.subs.set(MemoryCursorStore.key(record.pluginInstanceId, record.subscriptionId), record);
    this.subscriptionByHandle.set(
      MemoryCursorStore.handleKey(record.pluginInstanceId, record.handleId),
      record.subscriptionId,
    );
  }

  async get(pluginInstanceId: string, subscriptionId: string): Promise<SubscriptionRecord | null> {
    return this.subs.get(MemoryCursorStore.key(pluginInstanceId, subscriptionId)) ?? null;
  }

  async findByHandle(pluginInstanceId: string, handleId: string): Promise<SubscriptionRecord | null> {
    const subscriptionId = this.subscriptionByHandle.get(MemoryCursorStore.handleKey(pluginInstanceId, handleId));
    if (!subscriptionId) return null;
    const record = this.subs.get(MemoryCursorStore.key(pluginInstanceId, subscriptionId));
    return record && record.revokedAt === undefined ? record : null;
  }

  async createOrGet(record: SubscriptionRecord): Promise<SubscriptionRecord> {
    // Deliberately no await: this check+write block is atomic in one JS turn.
    const handleKey = MemoryCursorStore.handleKey(record.pluginInstanceId, record.handleId);
    const existingId = this.subscriptionByHandle.get(handleKey);
    if (existingId) {
      const existing = this.subs.get(MemoryCursorStore.key(record.pluginInstanceId, existingId));
      if (existing && existing.revokedAt === undefined) return existing;
    }
    this.subs.set(MemoryCursorStore.key(record.pluginInstanceId, record.subscriptionId), record);
    this.subscriptionByHandle.set(handleKey, record.subscriptionId);
    return record;
  }

  async advanceAck(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (!record) return;
    if (sequence > record.ackedSequence) {
      this.subs.set(key, { ...record, ackedSequence: sequence });
    }
  }

  async advanceDelivered(pluginInstanceId: string, subscriptionId: string, sequence: number): Promise<void> {
    const key = MemoryCursorStore.key(pluginInstanceId, subscriptionId);
    const record = this.subs.get(key);
    if (!record) return;
    if (sequence > record.lastDeliveredSequence) {
      this.subs.set(key, { ...record, lastDeliveredSequence: sequence });
    }
  }

  async revokeByHandle(handleId: string, revokedAt: number): Promise<number> {
    let count = 0;
    for (const [key, record] of this.subs.entries()) {
      if (record.handleId === handleId && record.revokedAt === undefined) {
        this.subs.set(key, { ...record, revokedAt });
        count += 1;
      }
    }
    return count;
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
