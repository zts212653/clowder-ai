/**
 * Plugin Messaging — idempotent settlement ledger (K-1 / F288, AC-5)
 *
 * Key spaces (instance-scoped; reinstalled instances get fresh instanceIds so
 * old key spaces are never reused):
 *   send    = (pluginInstanceId, idempotencyKey)
 *   append  = (pluginInstanceId, messageId, operationId)
 *   ingress = (effect, pluginInstanceId, idempotencyKey) — one Host-side effect of one
 *             authenticated connector ingress, fenced separately from `send` because releasing
 *             the send claim does not undo a broadcast already on the wire or a cat already woken.
 *             The two effects carry SEPARATE fences on purpose: `broadcast` is at-most-once on its
 *             own terms (a duplicate doubles a visible bubble; a miss is recovered by any refetch),
 *             while `wake` must never be skipped, so a shared fence would let the cheap effect
 *             decide the expensive one (seventh-round review P1).
 * Segments are URI-encoded before joining so ':' inside ids cannot forge a
 * foreign key space.
 *
 * State machine (§4a): unclaimed → inflight → settled | released.
 * Defaults: claim TTL 60s (crash-orphan recovery), settled retention 7d
 * (documented at-least-once boundary — a retry after retention re-executes).
 */

import type { AppendReceipt, SendReceipt } from '@clowder-ai/plugin-contract';
import type { LedgerStore, SettleResult } from './stores/ports.js';

/**
 * The two Host-side effects of an ingress. They are fenced independently because they have
 * different costs of being wrong: a duplicate broadcast is cosmetic, a missing wake is silence.
 */
export type IngressEffect = 'broadcast' | 'wake';

/** What an ingress fence records: which message the Host already delivered this effect for. */
export interface IngressDeliveryReceipt {
  readonly messageId: string;
  /** Broadcast-only plugin speech has no wake target. */
  readonly catId?: string;
}

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

  private static ingressKey(effect: IngressEffect, instanceId: string, idempotencyKey: string): string {
    return key(['ingress', effect, instanceId, idempotencyKey]);
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

  /**
   * Fences ONE Host-side effect of one authenticated ingress. The send claim cannot do this job:
   * releasing it is how a failed attempt hands the work back, but a broadcast already on the wire
   * and a cat already woken do not come back with it.
   */
  async claimIngressEffect(
    effect: IngressEffect,
    instanceId: string,
    idempotencyKey: string,
  ): Promise<TypedClaim<IngressDeliveryReceipt>> {
    return (await this.store.claim(
      MessagingLedger.ingressKey(effect, instanceId, idempotencyKey),
      this.claimTtlMs,
    )) as TypedClaim<IngressDeliveryReceipt>;
  }

  async settleIngressEffect(
    effect: IngressEffect,
    instanceId: string,
    idempotencyKey: string,
    claimToken: string,
    receipt: IngressDeliveryReceipt,
  ): Promise<SettleResult> {
    return this.store.settle(
      MessagingLedger.ingressKey(effect, instanceId, idempotencyKey),
      claimToken,
      receipt,
      this.retentionMs,
    );
  }

  /** Hands an undelivered effect back so the next attempt re-runs it (failure path). */
  async releaseIngressEffect(
    effect: IngressEffect,
    instanceId: string,
    idempotencyKey: string,
    claimToken: string,
  ): Promise<void> {
    await this.store.release(MessagingLedger.ingressKey(effect, instanceId, idempotencyKey), claimToken);
  }
}
