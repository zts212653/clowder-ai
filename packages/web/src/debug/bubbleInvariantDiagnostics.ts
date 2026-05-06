import type { BubbleInvariantViolation } from '@cat-cafe/shared';
import { recordDebugEvent } from './invocationEventDebug';

export type BubbleInvariantLogLevel = 'warn' | 'error';

/**
 * F183 Phase E AC-E1 — strict mode toggle. Read at call time (not module
 * load) so test stubs work and runtime toggles take effect immediately.
 *
 * Three sources, any one truthy → strict ON:
 * 1. `NEXT_PUBLIC_BUBBLE_INVARIANT_STRICT=1` — bundled into browser builds;
 *    use for CI / alpha staging where you want every client strict
 * 2. `BUBBLE_INVARIANT_STRICT=1` — Node-only env; use for vitest / SSR
 * 3. `localStorage.catcafe.bubbleInvariantStrict === '1'` — browser runtime
 *    toggle; use for ad-hoc debugging in alpha without a rebuild
 *
 * Truthy: `'1'` exact match. Empty / `'0'` / unset / any other → off.
 *
 * 砚砚 R1 P1 fix: prior version only checked `process.env`; that doesn't
 * survive Next.js client bundling and `export FOO=1` doesn't reach a
 * running browser session. Tri-source check makes "dev/runtime assertion"
 * actually accessible in browser without restart.
 */
/**
 * Exported for callers (e.g., chatStore writers) that want to early-out
 * before doing the O(n) scan when strict is off — keeps non-strict
 * production hot path free of invariant overhead.
 */
export function isBubbleInvariantStrictModeOn(): boolean {
  return isStrictModeOn();
}

function isStrictModeOn(): boolean {
  // 1. Build-time browser-visible env (NEXT_PUBLIC_* prefix is bundled by Next.js)
  if (typeof process !== 'undefined' && process.env?.NEXT_PUBLIC_BUBBLE_INVARIANT_STRICT === '1') {
    return true;
  }
  // 2. Node-only env (vitest / SSR)
  if (typeof process !== 'undefined' && process.env?.BUBBLE_INVARIANT_STRICT === '1') {
    return true;
  }
  // 3. Runtime localStorage flag — browser ad-hoc toggle without rebuild.
  //    Cloud R1 P1: the entire access path must be inside try/catch — even
  //    `typeof globalThis.localStorage` evaluates the property and can throw
  //    SecurityError in storage-restricted iframe / privacy contexts. Prior
  //    `typeof X !== 'undefined'` outside try { ... } leaked the throw.
  try {
    if (
      typeof globalThis !== 'undefined' &&
      globalThis.localStorage?.getItem('catcafe.bubbleInvariantStrict') === '1'
    ) {
      return true;
    }
  } catch {
    // Privacy mode / sandboxed iframe / disabled storage — strict stays off
  }
  return false;
}

export function recordBubbleInvariantViolation(
  violation: BubbleInvariantViolation,
  level: BubbleInvariantLogLevel = 'warn',
): void {
  const payload = { ...violation, level };
  if (level === 'error') {
    console.error('[F183] bubble invariant violation', payload);
  } else {
    console.warn('[F183] bubble invariant violation', payload);
  }

  recordDebugEvent({
    event: 'bubble_invariant_violation',
    ...payload,
  });

  // F183 Phase E AC-E1: dev/CI can opt-in to strict throwing so dormant
  // violations surface as test failures instead of silent log spam. Default
  // OFF so production users don't crash on observability-only signals.
  // Note: throw happens AFTER recordDebugEvent so the timeline still captures
  // the violation even when the throw aborts the calling frame.
  if (isStrictModeOn()) {
    throw new Error(
      `[F183] bubble invariant violation (strict): ${violation.violationKind} ${violation.threadId}/${violation.actorId}/${violation.canonicalInvocationId}/${violation.bubbleKind}`,
    );
  }
}
