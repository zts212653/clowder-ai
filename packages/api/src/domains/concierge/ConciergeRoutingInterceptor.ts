/**
 * F229: Concierge Routing Interceptor
 *
 * Decouples concierge context logic from routing core (GuideRoutingInterceptor 同模式).
 *
 * Called once before the per-cat loop:
 *   const conciergeCtx = await prepareConciergeContext(routeThread, userId, deps.invocationDeps.conciergeConfigStore);
 *   // Inside buildInvocationContext:
 *   ...conciergeCtx,
 */

import type { ConciergeConfig } from '@cat-cafe/shared';
import type { Thread } from '../cats/services/stores/ports/ThreadStore.js';
import type { IConciergeConfigStore } from './ConciergeConfigStore.js';

/** Shape spread into buildInvocationContext when thread is a concierge thread. */
export interface ConciergeInvocationContext {
  threadKind: 'concierge';
  conciergeConfig: ConciergeConfig;
}

/**
 * Resolve concierge invocation context for the current thread.
 *
 * Returns ConciergeInvocationContext when:
 *   - thread.threadKind === 'concierge', AND
 *   - conciergeConfigStore is provided
 *
 * Returns empty object otherwise (normal threads unaffected).
 */
export async function prepareConciergeContext(
  thread: Thread | null,
  userId: string,
  store: IConciergeConfigStore | undefined,
): Promise<ConciergeInvocationContext | Record<string, never>> {
  if (thread?.threadKind !== 'concierge' || !store) return {};
  const config = await store.get(userId);
  return { threadKind: 'concierge', conciergeConfig: config };
}

/**
 * Per-cat injection gate (GuideRoutingInterceptor.guideContextForCat 同模式).
 *
 * Returns ConciergeInvocationContext only when catId === config.dutyCatProfileId.
 * All other cats on a concierge thread (A2A, user @mentions) get empty context —
 * the 岗位 prompt is exclusively for the configured duty cat.
 *
 * Usage (inside per-cat loop):
 *   ...conciergeContextForCat(conciergeCtx, catId),
 */
export function conciergeContextForCat(
  ctx: ConciergeInvocationContext | Record<string, never>,
  catId: string,
): ConciergeInvocationContext | Record<string, never> {
  if (!('conciergeConfig' in ctx)) return {};
  return ctx.conciergeConfig.dutyCatProfileId === catId ? ctx : {};
}
