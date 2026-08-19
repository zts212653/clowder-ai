/**
 * Plugin Messaging — idempotent settlement ledger (K-1 / F288, AC-5)
 *
 * Key spaces (instance-scoped; reinstalled instances get fresh instanceIds so
 * old key spaces are never reused):
 *   send   = (pluginInstanceId, idempotencyKey)
 *   append = (pluginInstanceId, messageId, operationId)
 * Segments are URI-encoded before joining so ':' inside ids cannot forge a
 * foreign key space.
 *
 * State machine (§4a): unclaimed → inflight → settled | released.
 * Defaults: claim TTL 60s (crash-orphan recovery), settled retention 7d
 * (documented at-least-once boundary — a retry after retention re-executes).
 */

import type { AppendReceipt, SendReceipt } from '@clowder-ai/plugin-contract';
import type { LedgerStore, SettleResult } from './stores/ports.js';

export const LEDGER_CLAIM_TTL_MS = 60_000;
export const LEDGER_RETENTION_MS = 7 * 24 * 3600 * 1000;

export type TypedClaim<R> =
  | { readonly status: 'new'; readonly claimToken: string }
  | { readonly status: 'inflight' }
  | { readonly status: 'settled'; readonly receipt: R };

function key(parts: readonly string[]): string {
  return parts.map((p) => encodeURIComponent(p)).join(':');
}

export class MessagingLedger {
  private readonly store: LedgerStore;
  private readonly claimTtlMs: number;
  private readonly retentionMs: number;

  constructor(store: LedgerStore, options?: { claimTtlMs?: number; retentionMs?: number }) {
    this.store = store;
    this.claimTtlMs = options?.claimTtlMs ?? LEDGER_CLAIM_TTL_MS;
    this.retentionMs = options?.retentionMs ?? LEDGER_RETENTION_MS;
  }

  private static sendKey(instanceId: string, idempotencyKey: string): string {
    return key(['send', instanceId, idempotencyKey]);
  }

  private static appendKey(instanceId: string, messageId: string, operationId: string): string {
    return key(['append', instanceId, messageId, operationId]);
  }

  async claimSend(instanceId: string, idempotencyKey: string): Promise<TypedClaim<SendReceipt>> {
    return (await this.store.claim(
      MessagingLedger.sendKey(instanceId, idempotencyKey),
      this.claimTtlMs,
    )) as TypedClaim<SendReceipt>;
  }

  async settleSend(
    instanceId: string,
    idempotencyKey: string,
    claimToken: string,
    receipt: SendReceipt,
  ): Promise<SettleResult> {
    return this.store.settle(
      MessagingLedger.sendKey(instanceId, idempotencyKey),
      claimToken,
      receipt,
      this.retentionMs,
    );
  }

  async releaseSend(instanceId: string, idempotencyKey: string, claimToken: string): Promise<void> {
    await this.store.release(MessagingLedger.sendKey(instanceId, idempotencyKey), claimToken);
  }

  async claimAppend(instanceId: string, messageId: string, operationId: string): Promise<TypedClaim<AppendReceipt>> {
    return (await this.store.claim(
      MessagingLedger.appendKey(instanceId, messageId, operationId),
      this.claimTtlMs,
    )) as TypedClaim<AppendReceipt>;
  }

  async settleAppend(
    instanceId: string,
    messageId: string,
    operationId: string,
    claimToken: string,
    receipt: AppendReceipt,
  ): Promise<SettleResult> {
    return this.store.settle(
      MessagingLedger.appendKey(instanceId, messageId, operationId),
      claimToken,
      receipt,
      this.retentionMs,
    );
  }

  async releaseAppend(instanceId: string, messageId: string, operationId: string, claimToken: string): Promise<void> {
    await this.store.release(MessagingLedger.appendKey(instanceId, messageId, operationId), claimToken);
  }
}
