/**
 * F247 AC-B1c-2: Cloud invoke bridge — shared types.
 *
 * Defines the contract between `invokeSingleCat` (caller) and the bridge
 * implementation, which appends ChatGPT Pro mentions to the bound conversation
 * through the receipt-bearing conversation Host adapter.
 */

import type { CatId, CloudBridgeFailureDiagnosticV1, CloudBridgeOutboundReceiptV1 } from '@cat-cafe/shared';

/**
 * Server-authored provenance for one exact cloud dispatch child.
 *
 * Queue carriers preserve this value unchanged; route layers must not
 * reconstruct it from display text or the current queue row.
 */
export interface CloudDispatchProvenance {
  readonly sourceMessageId: string;
  readonly sourceSender: CloudBridgeOutboundReceiptV1['sourceSender'];
  readonly calledByCatId: CatId;
  readonly intent: string;
}

/**
 * Parameters passed to the bridge when a local cat @ mentions a cloud cat.
 *
 * The bridge uses these to build a source-bound thread runtime delta payload
 * (KD-21 / AC-B1c-12) and inject it into the cloud cat's ChatGPT chat.
 */
export interface CloudInvokeDispatchParams {
  /** The cloud cat that was @ mentioned (e.g. 'gpt-pro'). */
  readonly catId: CatId;
  /** The local cat thread where the mention happened. */
  readonly threadId: string;
  /** The user who owns the thread (for ACL / OAuth scope). */
  readonly userId: string;
  /** Human-readable thread title for delta payload `threadTitle` field. May be null. */
  readonly threadTitle: string | null;
  /** Participants in the thread (other cats + user handles) for delta payload. */
  readonly participants: ReadonlyArray<{
    readonly catId: CatId | string;
    readonly handle: string;
  }>;
  /** The cat that @ mentioned the cloud cat (delta payload `calledBy` field). */
  readonly calledBy: CatId | string;
  /**
   * The mention text — what the cloud cat is being asked. Becomes the runtime
   * delta `intent` field. Length should be reasonable (delta payload is capped
   * at 2000 char per AC-B1c-12; long intents are truncated by the payload
   * builder, not by the caller).
   */
  readonly intent: string;
  /** Exact persisted source message ID: return anchor and Host idempotency key. */
  readonly sourceMessageId: string;
}

/**
 * Bridge dispatch outcome — observable for tests + logging.
 */
export type BridgeDispatchOutcome =
  | {
      readonly kind: 'sent';
      readonly capturedUrl: string;
      /** The only transport; the legacy PinchTab bridge was removed (issue #1538). */
      readonly transport: 'host';
      readonly hostMessageId: string;
      readonly idempotentReplay?: boolean;
    }
  | {
      readonly kind: 'fallback';
      readonly reason: BridgeFallbackReason;
      readonly detail?: string;
      readonly idempotentReplay?: boolean;
    }
  | {
      readonly kind: 'error';
      readonly reason: Extract<BridgeFallbackReason, 'host-append-failed' | 'dispatch-failed'>;
      readonly message: string;
      readonly detail?: string;
      readonly idempotentReplay?: boolean;
      readonly failureDiagnostic?: CloudBridgeFailureDiagnosticV1;
    };

/**
 * Why a dispatch did not end in a Host receipt. `dispatch-failed` is the bridge's last-resort
 * catch: it failed before producing a transport outcome, so the effect is unknown. Messages and
 * receipts written before the PinchTab bridge was removed may still carry its reasons; they are
 * read as stored and never produced again.
 */
export type BridgeFallbackReason =
  | 'no-adapter'
  | 'needs-binding'
  | 'dispatch-failed'
  | 'host-append-failed'
  | 'missing-source-message-id'
  | 'incomplete-dispatch-provenance'
  | 'ambiguous-cloud-cat'
  | 'source-retargeted'
  | 'source-history-unknown';

/**
 * The cloud invoke bridge — awaited by `invokeSingleCat` only until a bounded
 * transport receipt/failure is known. Implementation is responsible for:
 *
 *  1. Building the source-bound delta payload (AC-B1c-12) with JSON.stringify
 *     safety (AC-B1c-10).
 *  2. Reading the binding from the thread metadata.
 *  3. Appending to the bound conversation through the conversation Host adapter.
 *  4. Emitting a `system_info` fallback notification to the local thread
 *     when there is no adapter or binding, or the append fails (AC-B1c-4).
 *
 * The interface returns the bounded transport outcome. The local invocation
 * waits only for this receipt/failure boundary — never for the cloud cat's
 * eventual MCP response — so it can publish one truthful status and settle
 * the exact source carrier.
 */
export interface ICloudInvokeBridge {
  dispatch(params: CloudInvokeDispatchParams): Promise<BridgeDispatchOutcome>;
}
