/**
 * Parallel Tool Budget — F203 Phase E hotfix.
 *
 * Parallel (ideate) mode is for independent, concise answers. A runaway
 * exploration loop (e.g. spawning Agent(Explore) and then hundreds of
 * Bash/Read calls) wastes tokens and can get the CLI process killed.
 *
 * This module gives route-parallel a per-cat tool-call ceiling plus a way to
 * abort only that cat without taking down its siblings.
 */

import type { CatId } from '@cat-cafe/shared';

/**
 * Maximum number of tool_use events a single parallel cat may emit before the
 * route forcibly aborts that cat. Configurable via environment; default is high
 * enough for genuine parallel ideation but low enough to stop a 12-minute
 * runaway loop.
 */
export function getMaxParallelToolCalls(): number {
  const raw = process.env.CAT_CAFE_PARALLEL_MAX_TOOL_CALLS;
  if (!raw) return 100;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 100;
}

/** Tracks per-cat tool usage and whether the budget was already enforced. */
export class ParallelToolBudgetTracker {
  private readonly counts = new Map<string, number>();
  private readonly exceeded = new Set<string>();

  constructor(private readonly maxCalls: number) {}

  /**
   * Record one tool_use for `catId`.
   * @returns true the first time this cat exceeds the budget (caller should abort).
   */
  recordToolUse(catId: string): boolean {
    const next = (this.counts.get(catId) ?? 0) + 1;
    this.counts.set(catId, next);
    if (next > this.maxCalls && !this.exceeded.has(catId)) {
      this.exceeded.add(catId);
      return true;
    }
    return false;
  }

  isExceeded(catId: string): boolean {
    return this.exceeded.has(catId);
  }

  getCount(catId: string): number {
    return this.counts.get(catId) ?? 0;
  }
}

export interface PerCatSignalProvider {
  signalForCat: (catId: CatId) => AbortSignal | undefined;
  abortCat: (catId: CatId, reason?: string) => void;
}

/**
 * Create per-cat AbortControllers that compose with the caller-provided
 * signalForCat/signal. Aborting one cat does not abort its siblings.
 */
export function createPerCatSignalProvider(
  targetCats: readonly CatId[],
  parentSignal?: AbortSignal,
  parentSignalForCat?: (catId: CatId) => AbortSignal | undefined,
): PerCatSignalProvider {
  const controllers = new Map<string, AbortController>();
  for (const catId of targetCats) {
    controllers.set(catId as string, new AbortController());
  }

  const signals = new Map<string, AbortSignal | undefined>();

  function getParentSignal(catId: CatId): AbortSignal | undefined {
    return parentSignalForCat?.(catId) ?? parentSignal;
  }

  function buildSignal(catId: CatId): AbortSignal | undefined {
    const ctrl = controllers.get(catId as string);
    const parent = getParentSignal(catId);
    if (!ctrl) return parent;
    if (!parent) return ctrl.signal;
    if (parent.aborted) {
      ctrl.abort(parent.reason);
      return ctrl.signal;
    }
    const onAbort = (): void => ctrl.abort(parent.reason);
    parent.addEventListener('abort', onAbort, { once: true });
    return ctrl.signal;
  }

  return {
    signalForCat: (catId: CatId) => {
      const key = catId as string;
      if (signals.has(key)) return signals.get(key);
      const signal = buildSignal(catId);
      signals.set(key, signal);
      return signal;
    },
    abortCat: (catId, reason) => {
      controllers.get(catId as string)?.abort(reason);
    },
  };
}
