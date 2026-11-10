/**
 * F247 AC-B1c-2 + AC-B1c-4: Cloud invoke bridge — main service.
 *
 * Bounded transport orchestrator that takes a local @ mention of a cloud cat
 * (e.g. @gpt-pro) and appends it to that cat's bound ChatGPT conversation
 * through the receipt-bearing conversation Host adapter.
 *
 *  - AC-B1c-2: non-throwing transport-outcome contract
 *  - AC-B1c-4: fallback notification when there is no adapter or binding, or the append fails
 *  - AC-B1c-9: (threadId, catId) singleflight — concurrent dispatches to one
 *    conversation reach the Host one at a time, in order
 *  - AC-B1c-12: source-bound delta payload format (delegated to build-delta-payload)
 *
 * The legacy PinchTab bridge, which drove the foreground ChatGPT tab and could
 * open a fresh chat, was removed (issue #1538): the bridge never
 * sends through a second transport after the Host declines.
 */

import { CHATGPT_CHAT_URL_REGEX } from '../../../../utils/chatgpt-chat-url.js';
import { buildDeltaPayload } from './build-delta-payload.js';
import { type BridgeLogger, type CloudInvokeBridgeDeps, noopBridgeLogger } from './cloud-invoke-bridge-deps.js';
import { dispatchBoundConversationThroughHost } from './conversation-host-dispatch.js';
import type {
  BridgeDispatchOutcome,
  BridgeFallbackReason,
  CloudInvokeDispatchParams,
  ICloudInvokeBridge,
} from './types.js';

export { buildCloudBridgeStatusContent, buildFallbackMessageContent } from './cloud-bridge-fallback.js';
export type { BridgeLogger, CloudInvokeBridgeDeps, EmitFallbackFn } from './cloud-invoke-bridge-deps.js';

/**
 * Cloud invoke bridge — default implementation.
 *
 * Awaited by `invokeSingleCat` only through the bounded transport outcome. The
 * `dispatch()` method:
 *   1. Builds the source-bound delta payload (AC-B1c-12 + exact source return capability).
 *   2. Reads the existing conversation binding (if any) from thread metadata.
 *   3. Appends to the bound conversation through the Host adapter and returns
 *      its receipt.
 *   4. With no adapter, no binding or a failed append it emits a fallback and
 *      returns a typed outcome (no exception escapes the transport boundary).
 *
 * Errors are caught and returned as typed outcomes. The invocation owns the
 * single user-visible status and exact source-carrier settlement.
 */
export class CloudInvokeBridge implements ICloudInvokeBridge {
  /**
   * AC-B1c-9: In-process singleflight lock map.
   * Key: `${threadId}:${catId}` — ensures concurrent dispatches to the same
   * (thread, cloud cat) pair are serialized. The lock is acquired BEFORE any
   * binding read (lock-first ordering per KD-20 R2).
   *
   * Why in-process Map instead of Redis lock: the bridge runs single-node
   * (the conversation Host is local); a cross-node lock is unnecessary overhead.
   */
  private readonly singleflightLocks = new Map<string, Promise<BridgeDispatchOutcome>>();

  /** AC-B1c-9: Lock TTL auto-release (30s per spec §8). */
  private static readonly LOCK_TTL_MS = 30_000;

  constructor(private readonly deps: CloudInvokeBridgeDeps) {}

  private get logger(): BridgeLogger {
    return this.deps.logger ?? noopBridgeLogger;
  }

  async dispatch(params: CloudInvokeDispatchParams): Promise<BridgeDispatchOutcome> {
    try {
      const outcome = await this.dispatchInternal(params);
      this.logger.info(
        { threadId: params.threadId, catId: params.catId, outcomeKind: outcome.kind },
        'F247 B1c bridge dispatch complete',
      );
      return outcome;
    } catch (err) {
      // Last-resort safety: bridge MUST NOT throw to the caller. The caller
      // consumes this structured failure to close the exact source carrier.
      const detail = `Cloud bridge failed before producing a transport outcome: ${shortMessage(err)}`;
      this.logger.warn(
        { threadId: params.threadId, catId: params.catId, err: serializeError(err) },
        'F247 B1c bridge dispatch threw (caught — structured failure returned)',
      );
      await this.fallback(params, 'dispatch-failed', detail);
      return { kind: 'error', reason: 'dispatch-failed', message: shortMessage(err), detail };
    }
  }

  /**
   * Internal entry — returns a structured outcome for logging and (in
   * tests) observability.
   *
   * AC-B1c-9: Wraps the core dispatch in a singleflight lock keyed by
   * `(threadId, catId)`. Concurrent callers with the same key wait for the
   * first holder to finish and read the binding inside the lock, so sends to
   * one conversation reach the Host one at a time, in order.
   */
  async dispatchInternal(params: CloudInvokeDispatchParams): Promise<BridgeDispatchOutcome> {
    if (!params.sourceMessageId || params.sourceMessageId.length > 512) {
      const detail = 'Cloud dispatch requires one exact persisted source message ID';
      await this.fallback(params, 'missing-source-message-id', detail);
      return { kind: 'fallback', reason: 'missing-source-message-id', detail };
    }
    const lockKey = `${params.threadId}:${params.catId}`;

    // AC-B1c-9: Wait for any in-flight dispatch on the same (threadId, catId).
    // Loop because when 3+ callers wait on the same holder, all wake
    // simultaneously via microtask queue when the holder resolves. Without
    // the loop, they'd all skip the check and race into dispatch.
    let existing = this.singleflightLocks.get(lockKey);
    while (existing) {
      await existing.catch(() => {
        /* swallow — we'll do our own attempt */
      });
      // Re-check: another waiter may have grabbed the lock before us.
      existing = this.singleflightLocks.get(lockKey);
    }

    // Now acquire the lock: store our promise so subsequent callers wait.
    let releaseLock!: () => void;
    const lockPromise = new Promise<BridgeDispatchOutcome>((resolve) => {
      releaseLock = () => resolve(undefined as unknown as BridgeDispatchOutcome);
    });
    this.singleflightLocks.set(lockKey, lockPromise);

    // TTL auto-release: if the dispatch hangs, release the lock after 30s
    // so the next caller isn't blocked forever. Must also resolve the promise
    // (not just delete from map) — otherwise waiters on `await existing` stay
    // stuck even after the map entry is gone (cloud P2 fix).
    const ttlTimer = setTimeout(() => {
      if (this.singleflightLocks.get(lockKey) === lockPromise) {
        this.singleflightLocks.delete(lockKey);
        releaseLock(); // unblock any waiters (safe: resolve is idempotent)
        this.logger.warn(
          { threadId: params.threadId, catId: params.catId },
          'F247 B1c bridge: singleflight lock TTL expired',
        );
      }
    }, CloudInvokeBridge.LOCK_TTL_MS);

    try {
      const outcome = await this.dispatchCore(params);
      return outcome;
    } finally {
      // Release the lock
      clearTimeout(ttlTimer);
      if (this.singleflightLocks.get(lockKey) === lockPromise) {
        this.singleflightLocks.delete(lockKey);
      }
      releaseLock();
    }
  }

  /** Appends to the bound conversation through the Host adapter; any other case is a typed fallback. */
  private async dispatchCore(params: CloudInvokeDispatchParams): Promise<BridgeDispatchOutcome> {
    const { hostAdapter } = this.deps;

    // 1. Build delta payload (AC-B1c-12).
    const renderedPrompt = buildDeltaPayload(params);

    // 2. Resolve the stable host conversation. The Host adapter can append only
    // to an existing binding; it never manufactures a conversation.
    const boundUrl = await this.readBoundUrl(params);
    if (hostAdapter && !boundUrl) {
      const detail = 'Personal Chrome Host is available, but this thread has no bound ChatGPT conversation';
      await this.fallback(params, 'needs-binding', detail);
      return { kind: 'fallback', reason: 'needs-binding', detail };
    }
    const hostDecision = await dispatchBoundConversationThroughHost({
      adapter: hostAdapter,
      boundUrl,
      renderedPrompt,
      params,
    });
    if (hostDecision) {
      if (hostDecision.fallback) {
        await this.fallback(params, hostDecision.fallback.reason, hostDecision.fallback.detail);
      }
      return hostDecision.outcome;
    }

    // 3. No conversation Host adapter can take it (none installed, or it is
    // unavailable). There is no second transport to try.
    const detail = boundUrl ? 'No conversation Host Adapter is available' : 'No bound host conversation is available';
    await this.fallback(params, 'no-adapter', detail);
    return { kind: 'fallback', reason: 'no-adapter', detail };
  }

  /**
   * Read the bound URL from thread metadata. Returns null if no binding or
   * binding fails regex validation.
   */
  private async readBoundUrl(params: CloudInvokeDispatchParams): Promise<string | null> {
    try {
      const bindings = (await this.deps.threadStore.getCloudCatBindings(params.threadId)) as Record<string, string>;
      const existing = bindings[params.catId as unknown as string];
      if (existing && CHATGPT_CHAT_URL_REGEX.test(existing)) {
        return existing;
      }
    } catch (err) {
      this.logger.warn(
        { threadId: params.threadId, catId: params.catId, err: serializeError(err) },
        'F247 B1c bridge: failed to read existing binding (treating as none)',
      );
    }
    return null;
  }

  private async fallback(
    params: CloudInvokeDispatchParams,
    reason: BridgeFallbackReason,
    detail: string,
  ): Promise<void> {
    try {
      await this.deps.emitFallback({
        threadId: params.threadId,
        catId: params.catId,
        reason,
        detail,
      });
    } catch (err) {
      this.logger.warn(
        { threadId: params.threadId, catId: params.catId, reason, err: serializeError(err) },
        'F247 B1c bridge: fallback notification emit failed',
      );
    }
  }
}

function shortMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

function serializeError(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}
