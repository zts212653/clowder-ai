/**
 * F247 AC-B1c-2 + AC-B1c-4: Cloud invoke bridge — main service.
 *
 * Fire-and-forget orchestrator that takes a local @ mention of a cloud cat
 * (e.g. @gpt-pro) and pushes it to that cat's bound ChatGPT chat via a
 * PinchTab CDP adapter.
 *
 * Scope of this PR (B1c PR-B):
 *  - AC-B1c-2: service skeleton + dispatch fire-and-forget contract
 *  - AC-B1c-4: fallback notification on adapter unavailable / inject failure
 *  - AC-B1c-10: eval-boundary JSON.stringify safety (delegated to build-delta-payload + adapter)
 *  - AC-B1c-12: 5-field delta payload format (delegated to build-delta-payload)
 *
 * PR-D (B1c hardening, this PR) adds:
 *  - AC-B1c-9: (threadId, catId) singleflight lock-first ordering —
 *    concurrent dispatches serialized via in-process Map<string, Promise>
 *  - AC-B1c-6: stale binding self-heal — adapter fail on bound URL →
 *    clear binding → retry with boundUrl=null (open fresh chat)
 *  - AC-B1c-7: multi-thread × same cloud cat isolation (test coverage)
 *
 * Previously completed: PR-B (skeleton + fallback), PR-C (real CDP adapter).
 */

import type { CatId } from '@cat-cafe/shared';

import { CHATGPT_CHAT_URL_REGEX } from '../../../../utils/chatgpt-chat-url.js';
import type { IThreadStore } from '../stores/ports/ThreadStore.js';
import { buildDeltaPayload } from './build-delta-payload.js';
import type {
  BridgeDispatchOutcome,
  BridgeFallbackReason,
  CloudInvokeDispatchParams,
  ICloudInvokeBridge,
  IPinchTabBridgeAdapter,
} from './types.js';

/**
 * Callback invoked when the bridge needs to emit a fallback `system_info`
 * notification into the local thread (AC-B1c-4).
 *
 * The wire-up (in `packages/api/src/index.ts`) injects a real implementation
 * that posts to the message store + broadcasts to connected clients. Tests
 * use a recording mock.
 *
 * The bridge service itself does NOT depend on the message store directly;
 * it just calls this callback. Keeps the bridge unit-testable without
 * dragging in the full broadcast infrastructure.
 */
export type EmitFallbackFn = (params: {
  readonly threadId: string;
  readonly catId: CatId | string;
  readonly reason: BridgeFallbackReason;
  readonly detail?: string;
}) => Promise<void>;

/**
 * Minimal logger interface (matches pino — the project-wide logger
 * convention) without dragging in the pino types here.
 */
export interface BridgeLogger {
  warn(ctx: object, msg: string): void;
  info(ctx: object, msg: string): void;
  error?(ctx: object, msg: string): void;
}

export interface CloudInvokeBridgeDeps {
  /** Pluggable PinchTab CDP adapter. `null` → all dispatches fall back. */
  readonly pinchTabAdapter: IPinchTabBridgeAdapter | null;
  /** Emit a `system_info` block into the local thread on adapter failure. */
  readonly emitFallback: EmitFallbackFn;
  /** ThreadStore for reading + writing per-thread cloud cat bindings. */
  readonly threadStore: IThreadStore;
  /** Optional logger; tests pass a recording mock. */
  readonly logger?: BridgeLogger;
}

const noopLogger: BridgeLogger = {
  warn() {
    /* no-op */
  },
  info() {
    /* no-op */
  },
};

/**
 * Cloud invoke bridge — default implementation.
 *
 * Called fire-and-forget from `invokeSingleCat` when KD-17 dispatch guard
 * fires. The `dispatch()` method:
 *   1. Builds the 5-field delta payload (AC-B1c-12).
 *   2. Reads the existing chat URL binding (if any) from thread metadata.
 *   3. If no adapter or adapter not ready → emits fallback + returns
 *      (no exception escape — fire-and-forget contract requires this).
 *   4. Otherwise calls `adapter.injectAndCaptureUrl()`. The adapter is
 *      responsible for the actual CDP eval / send-button click / URL poll
 *      (deferred to PR-C).
 *   5. Validates the captured URL against `CHATGPT_CHAT_URL_REGEX` (defense
 *      in depth — adapter is also expected to validate, AC-B1c-11).
 *   6. Writes the new/refreshed binding via threadStore.
 *
 * Errors are caught and surfaced as fallback notifications; never thrown.
 */
export class CloudInvokeBridge implements ICloudInvokeBridge {
  /**
   * AC-B1c-9: In-process singleflight lock map.
   * Key: `${threadId}:${catId}` — ensures concurrent dispatches to the same
   * (thread, cloud cat) pair are serialized. The lock is acquired BEFORE any
   * binding read (lock-first ordering per KD-20 R2).
   *
   * Why in-process Map instead of Redis lock: the bridge runs single-node
   * (PinchTab Chrome is local); cross-node lock is unnecessary overhead.
   */
  private readonly singleflightLocks = new Map<string, Promise<BridgeDispatchOutcome>>();

  /** AC-B1c-9: Lock TTL auto-release (30s per spec §8). */
  private static readonly LOCK_TTL_MS = 30_000;

  constructor(private readonly deps: CloudInvokeBridgeDeps) {}

  private get logger(): BridgeLogger {
    return this.deps.logger ?? noopLogger;
  }

  async dispatch(params: CloudInvokeDispatchParams): Promise<void> {
    try {
      const outcome = await this.dispatchInternal(params);
      this.logger.info(
        { threadId: params.threadId, catId: params.catId, outcomeKind: outcome.kind },
        'F247 B1c bridge dispatch complete',
      );
    } catch (err) {
      // Last-resort safety: bridge MUST NOT throw to the caller (fire-and-forget).
      this.logger.warn(
        { threadId: params.threadId, catId: params.catId, err: serializeError(err) },
        'F247 B1c bridge dispatch threw (caught — no-op for caller)',
      );
    }
  }

  /**
   * Internal entry — returns a structured outcome for logging and (in
   * tests) observability.
   *
   * AC-B1c-9: Wraps the core dispatch in a singleflight lock keyed by
   * `(threadId, catId)`. Concurrent callers with the same key wait for the
   * first holder to finish, then re-read the binding inside the lock —
   * the second invocation sees the URL written by the first and navigates
   * to the bound chat instead of opening a duplicate.
   */
  async dispatchInternal(params: CloudInvokeDispatchParams): Promise<BridgeDispatchOutcome> {
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
      const outcome = await this.dispatchCoreWithSelfHeal(params);
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

  /**
   * Core dispatch logic with AC-B1c-6 self-heal: if the adapter throws on a
   * bound URL (stale chat), clear the binding and retry with boundUrl=null.
   */
  private async dispatchCoreWithSelfHeal(params: CloudInvokeDispatchParams): Promise<BridgeDispatchOutcome> {
    const { pinchTabAdapter, threadStore } = this.deps;

    // 1. Build delta payload (AC-B1c-12).
    const renderedPrompt = buildDeltaPayload(params);

    // 2. Adapter availability gate (AC-B1c-4).
    if (!pinchTabAdapter) {
      await this.fallback(params, 'no-adapter', 'PinchTab adapter not yet wired (B1c PR-C pending)');
      return { kind: 'fallback', reason: 'no-adapter' };
    }
    const ready = await pinchTabAdapter.isReady().catch(() => false);
    if (!ready) {
      await this.fallback(params, 'adapter-not-ready', 'PinchTab Chrome unreachable or ChatGPT not logged in');
      return { kind: 'fallback', reason: 'adapter-not-ready' };
    }

    // 3. Read existing binding INSIDE the lock (AC-B1c-9 lock-first ordering).
    const boundUrl = await this.readBoundUrl(params);

    // 4. Invoke adapter with self-heal retry on stale binding (AC-B1c-6).
    const injectResult = await this.injectWithSelfHeal(pinchTabAdapter, params, renderedPrompt, boundUrl);
    if (injectResult.kind !== 'ok') return injectResult.outcome;
    const capturedUrl = injectResult.capturedUrl;

    // 5. Defense-in-depth URL validation (AC-B1c-11).
    if (!CHATGPT_CHAT_URL_REGEX.test(capturedUrl)) {
      await this.fallback(
        params,
        'invalid-captured-url',
        `Captured URL did not match canonical pattern: ${capturedUrl.slice(0, 60)}`,
      );
      return { kind: 'fallback', reason: 'invalid-captured-url' };
    }

    // 6. Write binding (idempotent — same URL just refreshes).
    try {
      await threadStore.updateCloudCatBinding(params.threadId, params.catId, capturedUrl);
    } catch (err) {
      this.logger.warn(
        { threadId: params.threadId, catId: params.catId, capturedUrl, err: serializeError(err) },
        'F247 B1c bridge: binding write failed (message already delivered)',
      );
    }

    return { kind: 'sent', capturedUrl };
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

  /**
   * AC-B1c-6: Invoke the adapter with self-heal retry. If the adapter fails
   * on a bound URL, clears the stale binding and retries with boundUrl=null.
   * Returns { kind: 'ok', capturedUrl } on success, or { kind: 'failed', outcome }
   * with a pre-built BridgeDispatchOutcome on failure.
   */
  private async injectWithSelfHeal(
    adapter: IPinchTabBridgeAdapter,
    params: CloudInvokeDispatchParams,
    renderedPrompt: string,
    boundUrl: string | null,
  ): Promise<{ kind: 'ok'; capturedUrl: string } | { kind: 'failed'; outcome: BridgeDispatchOutcome }> {
    try {
      const capturedUrl = await adapter.injectAndCaptureUrl({ renderedPrompt, boundUrl });
      return { kind: 'ok', capturedUrl };
    } catch (err) {
      if (!boundUrl) {
        // No existing binding — no self-heal possible, just fail.
        await this.fallback(params, 'inject-failed', `PinchTab adapter inject failed: ${shortMessage(err)}`);
        return { kind: 'failed', outcome: { kind: 'error', message: shortMessage(err) } };
      }

      // Self-heal: bound URL failed (chat may be deleted). Clear stale + retry.
      this.logger.info(
        { threadId: params.threadId, catId: params.catId, staleUrl: boundUrl, err: serializeError(err) },
        'F247 B1c bridge: bound URL failed — self-heal retry (re-open fresh chat)',
      );
      try {
        await this.deps.threadStore.updateCloudCatBinding(params.threadId, params.catId, null);
      } catch {
        /* best-effort clear */
      }
      try {
        const capturedUrl = await adapter.injectAndCaptureUrl({ renderedPrompt, boundUrl: null });
        return { kind: 'ok', capturedUrl };
      } catch (retryErr) {
        await this.fallback(params, 'inject-failed', `PinchTab self-heal retry also failed: ${shortMessage(retryErr)}`);
        return { kind: 'failed', outcome: { kind: 'error', message: shortMessage(retryErr) } };
      }
    }
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

/**
 * Compose a default fallback emitter from a minimal "post system message"
 * primitive. Lets the wire-up code (index.ts) keep the bridge agnostic of
 * how messages actually get into the thread store + broadcast pipeline.
 */
export function buildFallbackMessageContent(args: {
  reason: BridgeFallbackReason;
  detail?: string;
  catId: CatId | string;
}): string {
  const headlineByReason: Record<BridgeFallbackReason, string> = {
    'no-adapter': `Cloud cat @${args.catId} bridge not yet wired (B1c PR-C pending).`,
    'adapter-not-ready': `Cloud cat @${args.catId} bridge unavailable: PinchTab Chrome unreachable or not logged in to ChatGPT.`,
    'inject-failed': `Cloud cat @${args.catId} bridge inject failed (DOM selector or eval error).`,
    'invalid-captured-url': `Cloud cat @${args.catId} bridge captured a non-canonical ChatGPT URL; binding not written.`,
  };
  const headline = headlineByReason[args.reason];
  return JSON.stringify({
    type: 'b1c_bridge_fallback',
    catId: args.catId,
    reason: args.reason,
    headline,
    detail: args.detail ?? '',
  });
}
