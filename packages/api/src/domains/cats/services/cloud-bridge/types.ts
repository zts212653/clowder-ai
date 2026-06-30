/**
 * F247 AC-B1c-2: Cloud invoke bridge — shared types.
 *
 * Defines the contract between `invokeSingleCat` (caller) and the bridge
 * implementation (which fires off ChatGPT Pro mentions via PinchTab CDP in
 * subsequent PR-C).
 */

import type { CatId } from '@cat-cafe/shared';

/**
 * Parameters passed to the bridge when a local cat @ mentions a cloud cat.
 *
 * The bridge uses these to build a 5-field thread runtime delta payload
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
}

/**
 * Pluggable adapter for talking to PinchTab Chrome via CDP.
 *
 * PR-B (this PR) ships only the interface + a logging/null stub. PR-C will
 * add the real CDP raw WebSocket implementation that injects the delta
 * payload into ChatGPT's `#prompt-textarea`, clicks the send button, polls
 * `window.location.href` for the new `/c/<id>` URL, and writes the binding
 * back via `threadStore.updateCloudCatBinding`.
 */
export interface IPinchTabBridgeAdapter {
  /**
   * Returns true if PinchTab CDP is reachable AND ChatGPT is logged in.
   * Bridge uses this to decide between dispatching for real vs emitting a
   * fallback notification (AC-B1c-4).
   */
  isReady(): Promise<boolean>;
  /**
   * Inject the rendered delta payload into the cloud cat's bound ChatGPT
   * chat and capture the resulting chat URL.
   *
   * Returns the captured `https://chatgpt.com/c/<id>` URL (validated by the
   * adapter against `CHATGPT_CHAT_URL_REGEX`), or throws on:
   *  - chrome down / not logged in
   *  - selector failure (ChatGPT DOM changed)
   *  - URL capture failure (regex mismatch)
   *  - eval timeout
   */
  injectAndCaptureUrl(args: {
    /**
     * The rendered delta payload + intent (already wrapped in
     * `<thread-runtime>` block — caller pre-builds via `buildDeltaPayload`).
     */
    readonly renderedPrompt: string;
    /**
     * Existing bound chat URL for this (thread, cat) pair. If null, the
     * adapter opens a new chat at `https://chatgpt.com/` and captures the
     * resulting `/c/<id>` URL on first send.
     */
    readonly boundUrl: string | null;
  }): Promise<string>;
}

/**
 * Bridge dispatch outcome — observable for tests + logging.
 */
export type BridgeDispatchOutcome =
  | { readonly kind: 'sent'; readonly capturedUrl: string }
  | { readonly kind: 'fallback'; readonly reason: BridgeFallbackReason }
  | { readonly kind: 'error'; readonly message: string };

export type BridgeFallbackReason = 'adapter-not-ready' | 'no-adapter' | 'invalid-captured-url' | 'inject-failed';

/**
 * The cloud invoke bridge — invoked fire-and-forget from `invokeSingleCat`
 * when KD-17 guard fires. Implementation is responsible for:
 *
 *  1. Building the 5-field delta payload (AC-B1c-12) with JSON.stringify
 *     safety (AC-B1c-10).
 *  2. Reading the binding from the thread metadata.
 *  3. Invoking the PinchTab adapter (if ready) — AC-B1c-3 in PR-C.
 *  4. Writing the captured URL back to the binding.
 *  5. Emitting a `system_info` fallback notification to the local thread
 *     when adapter is unreachable / errors (AC-B1c-4).
 *
 * The interface returns `void` because `invokeSingleCat` MUST NOT block on
 * bridge dispatch — fire-and-forget per AC-B1c-2.
 */
export interface ICloudInvokeBridge {
  dispatch(params: CloudInvokeDispatchParams): Promise<void>;
}
