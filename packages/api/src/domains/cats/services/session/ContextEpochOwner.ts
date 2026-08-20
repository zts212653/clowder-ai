/**
 * F296 B1: Context epoch owner.
 *
 * One question, one owner: "is this cat still holding the working memory we last
 * projected into?" The epoch is the answer's generation counter. `contextMode` is
 * derived from it — never from unread volume, never from token usage.
 *
 * Ownership: `identity-session`. F296 surfaces consume this; they do not compute
 * their own continuity. See the frozen transition table in the F296 spec.
 */

import type { CatId } from '@cat-cafe/shared';
import {
  CONSUMED_COMPACTION_EVENT_LIMIT,
  type ContextEpochRecord,
  type IContextEpochStore,
} from '../stores/ports/ContextEpochStore.js';
import type { ContinuityDisposition } from '../types.js';

export interface ContextEpochScope {
  readonly userId: string;
  readonly catId: CatId | string;
  readonly threadId: string;
}

/**
 * An authoritative, provider-emitted compaction event.
 *
 * NOT a heuristic. Token drops, message drops, scratchpad text signatures and
 * auto-continue breakers are explicitly not this type — they travel as
 * `heuristicSignals` and are recorded as health telemetry only.
 */
export interface AuthoritativeCompactionEvent {
  /**
   * Stable per-event id, used for bounded replay suppression.
   *
   * Within the most recent `CONSUMED_COMPACTION_EVENT_LIMIT` consumed ids, a
   * replay does not advance the epoch again. Beyond that window the id has been
   * evicted and a replay WILL advance it (one extra cold generation — safe
   * direction, not free). This is not lifecycle-wide exact-once.
   */
  readonly eventId: string;
  /** Runtime the event was observed on; must match this scope's binding. */
  readonly runtimeSessionId?: string;
}

export type ContextEpochTransition =
  | 'scope_first_seen'
  | 'fresh'
  | 'replaced'
  | 'unknown'
  | 'binding_mismatch'
  | 'resumed'
  | 'context_compacted';

export interface ContextEpochState {
  readonly scopeKey: string;
  readonly contextEpoch: number;
  readonly contextMode: 'cold' | 'hot';
  readonly boundRuntimeSessionId?: string;
  readonly lastTransitionRef: string;
  /** Bounded FIFO of authoritative compaction event ids already consumed. */
  readonly consumedCompactionEventIds: readonly string[];
}

export interface ContextEpochTransitionResult {
  readonly state: ContextEpochState;
  readonly transition: ContextEpochTransition;
  /**
   * The disposition after normalization. A `resumed` claim we cannot corroborate
   * against the stored binding is downgraded here rather than trusted.
   */
  readonly normalizedDisposition: ContinuityDisposition;
  /** Heuristic observations, passed through for telemetry. Never epoch inputs. */
  readonly healthSignals: readonly string[];
}

export const CONTEXT_EPOCH_SCOPE_SEPARATOR = '::';

/**
 * Scope key = `user :: cat :: thread`.
 *
 * Explicit printable separator on purpose: this string is a Redis key, and an
 * operator has to be able to read it in `redis-cli`. None of the three id spaces
 * contains `::`.
 */
export function contextEpochScopeKey(scope: ContextEpochScope): string {
  return [scope.userId, scope.catId as string, scope.threadId].join(CONTEXT_EPOCH_SCOPE_SEPARATOR);
}

function bindingOf(disposition: ContinuityDisposition): string | undefined {
  return 'runtimeSessionId' in disposition ? disposition.runtimeSessionId : undefined;
}

function stateOf(input: {
  scopeKey: string;
  contextEpoch: number;
  contextMode: 'cold' | 'hot';
  boundRuntimeSessionId?: string;
  lastTransitionRef: string;
  consumedCompactionEventIds: readonly string[];
}): ContextEpochState {
  return {
    scopeKey: input.scopeKey,
    contextEpoch: input.contextEpoch,
    contextMode: input.contextMode,
    ...(input.boundRuntimeSessionId ? { boundRuntimeSessionId: input.boundRuntimeSessionId } : {}),
    lastTransitionRef: input.lastTransitionRef,
    consumedCompactionEventIds: input.consumedCompactionEventIds,
  };
}

/** Newest-wins bounded FIFO. Older ids age out; that bound is part of the contract. */
function withConsumedEvent(existing: readonly string[], eventId: string): readonly string[] {
  const next = existing.filter((id) => id !== eventId);
  next.push(eventId);
  return next.slice(-CONSUMED_COMPACTION_EVENT_LIMIT);
}

/**
 * Pure transition. Every branch is a row of the frozen table; the default for
 * anything we cannot prove is `cold` with an advanced epoch (fail closed).
 */
export function applyContinuityToEpoch(input: {
  readonly scopeKey: string;
  readonly previous: ContextEpochState | null;
  readonly disposition: ContinuityDisposition;
  readonly compaction?: AuthoritativeCompactionEvent;
  readonly heuristicSignals?: readonly string[];
}): ContextEpochTransitionResult {
  const { scopeKey, disposition } = input;
  // Records persisted before B2a carry no consumed list. Degrading to "nothing
  // consumed" costs at most one extra cold rebuild; the opposite default would
  // silently swallow a real compaction.
  const previous = input.previous
    ? { ...input.previous, consumedCompactionEventIds: input.previous.consumedCompactionEventIds ?? [] }
    : null;
  const healthSignals = [...(input.heuristicSignals ?? [])];
  const claimedBinding = bindingOf(disposition);

  // Row: scope first appearance. Nothing to resume into, whatever the carrier says.
  if (!previous) {
    return {
      state: stateOf({
        scopeKey,
        contextEpoch: 1,
        contextMode: 'cold',
        ...(claimedBinding ? { boundRuntimeSessionId: claimedBinding } : {}),
        lastTransitionRef: disposition.evidenceRef,
        consumedCompactionEventIds: [],
      }),
      transition: 'scope_first_seen',
      normalizedDisposition: disposition,
      healthSignals,
    };
  }

  const advance = (
    transition: ContextEpochTransition,
    next: {
      boundRuntimeSessionId?: string;
      normalizedDisposition?: ContinuityDisposition;
      consumedCompactionEventId?: string;
    },
  ): ContextEpochTransitionResult => ({
    state: stateOf({
      scopeKey,
      contextEpoch: previous.contextEpoch + 1,
      contextMode: 'cold',
      ...(next.boundRuntimeSessionId ? { boundRuntimeSessionId: next.boundRuntimeSessionId } : {}),
      lastTransitionRef: disposition.evidenceRef,
      // Carried across EVERY transition: forgetting a consumed id on fresh /
      // unknown / replaced is exactly how a replayed event advanced twice.
      consumedCompactionEventIds: next.consumedCompactionEventId
        ? withConsumedEvent(previous.consumedCompactionEventIds, next.consumedCompactionEventId)
        : previous.consumedCompactionEventIds,
    }),
    transition,
    normalizedDisposition: next.normalizedDisposition ?? disposition,
    healthSignals,
  });

  switch (disposition.state) {
    // Row: fresh — new runtime memory, whether or not we got an id for it.
    case 'fresh':
      return advance('fresh', { ...(claimedBinding ? { boundRuntimeSessionId: claimedBinding } : {}) });

    // Row: replaced — bind the new runtime.
    case 'replaced':
      return advance('replaced', { boundRuntimeSessionId: disposition.runtimeSessionId });

    // Row: unknown — evidence insufficient or carrier unsupported. Fail closed and
    // drop the binding: we must not keep claiming a runtime we cannot corroborate.
    case 'unknown':
      return advance('unknown', {});

    case 'resumed': {
      // Row: resumed but binding missing/mismatched — the claim is not trustworthy,
      // so it is normalized to unknown(binding_mismatch) rather than believed.
      if (!previous.boundRuntimeSessionId || previous.boundRuntimeSessionId !== disposition.runtimeSessionId) {
        return advance('binding_mismatch', {
          normalizedDisposition: {
            state: 'unknown',
            reason: 'binding_mismatch',
            evidenceRef: disposition.evidenceRef,
          },
        });
      }

      // Row: authoritative compaction — the runtime kept its session, but its
      // working memory was rewritten. Advance the epoch once per event id within
      // the bounded consumed window, and keep the binding (same runtime).
      const compaction = input.compaction;
      const compactionAppliesHere =
        compaction !== undefined &&
        !previous.consumedCompactionEventIds.includes(compaction.eventId) &&
        (compaction.runtimeSessionId === undefined || compaction.runtimeSessionId === previous.boundRuntimeSessionId);
      if (compaction && compactionAppliesHere) {
        return advance('context_compacted', {
          boundRuntimeSessionId: previous.boundRuntimeSessionId,
          consumedCompactionEventId: compaction.eventId,
        });
      }

      // Row: resumed with an exact binding match — hold the epoch, stay hot.
      // Heuristic signals reach here too, and deliberately change nothing.
      return {
        state: stateOf({
          scopeKey,
          contextEpoch: previous.contextEpoch,
          contextMode: 'hot',
          boundRuntimeSessionId: previous.boundRuntimeSessionId,
          lastTransitionRef: disposition.evidenceRef,
          consumedCompactionEventIds: previous.consumedCompactionEventIds,
        }),
        transition: 'resumed',
        normalizedDisposition: disposition,
        healthSignals,
      };
    }

    default: {
      const exhaustive: never = disposition;
      throw new Error(`unhandled continuity disposition: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Store-backed owner. Reads the scope's previous epoch, applies the pure
 * transition, persists the result.
 *
 * It holds no cursor store on purpose: an epoch transition must never reset the
 * message delivery cursor or the seen cursor, and the cheapest way to guarantee
 * that is to make it unexpressible here.
 */
export class ContextEpochOwner {
  constructor(
    private readonly store: IContextEpochStore,
    private readonly maxCasAttempts = 5,
  ) {}

  /**
   * Read → apply the pure transition → commit under compare-and-set.
   *
   * The CAS is not defensive programming: there are two real writers on one
   * scope (the invocation path and the PreCompact hook route, which never takes
   * the invocation's process-local policy mutex). Without it both can land on
   * epoch N+1, and the B2 ledger key then means two different generations.
   */
  async resolve(input: {
    readonly userId: string;
    readonly catId: CatId | string;
    readonly threadId: string;
    readonly disposition: ContinuityDisposition;
    readonly compaction?: AuthoritativeCompactionEvent;
    readonly heuristicSignals?: readonly string[];
  }): Promise<
    ContextEpochState & {
      transition: ContextEpochTransition;
      normalizedDisposition: ContinuityDisposition;
      healthSignals: readonly string[];
    }
  > {
    const scopeKey = contextEpochScopeKey(input);

    for (let attempt = 0; attempt < this.maxCasAttempts; attempt++) {
      const stored = await Promise.resolve(this.store.get(scopeKey));
      const previous: ContextEpochState | null = stored
        ? stateOf({
            scopeKey: stored.scopeKey,
            contextEpoch: stored.contextEpoch,
            contextMode: stored.contextMode,
            ...(stored.boundRuntimeSessionId ? { boundRuntimeSessionId: stored.boundRuntimeSessionId } : {}),
            lastTransitionRef: stored.lastTransitionRef,
            consumedCompactionEventIds: stored.consumedCompactionEventIds ?? [],
          })
        : null;

      const result = applyContinuityToEpoch({
        scopeKey,
        previous,
        disposition: input.disposition,
        ...(input.compaction ? { compaction: input.compaction } : {}),
        ...(input.heuristicSignals ? { heuristicSignals: input.heuristicSignals } : {}),
      });

      const record: ContextEpochRecord = {
        scopeKey: result.state.scopeKey,
        contextEpoch: result.state.contextEpoch,
        contextMode: result.state.contextMode,
        ...(result.state.boundRuntimeSessionId ? { boundRuntimeSessionId: result.state.boundRuntimeSessionId } : {}),
        lastTransitionRef: result.state.lastTransitionRef,
        consumedCompactionEventIds: result.state.consumedCompactionEventIds,
        version: (stored?.version ?? 0) + 1,
        updatedAt: Date.now(),
      };

      const committed = await Promise.resolve(this.store.compareAndPut(record, stored?.version ?? 0));
      if (committed) {
        return {
          ...result.state,
          transition: result.transition,
          normalizedDisposition: result.normalizedDisposition,
          // Spec requires heuristics be recorded as health telemetry. Swallowing
          // them here would make that unreachable for every consumer.
          healthSignals: result.healthSignals,
        };
      }
      // Someone else committed first — re-read and re-apply this disposition on
      // top of their state. Dropping our transition would silently lose it.
    }

    throw new Error(`context_epoch_cas_exhausted:${scopeKey}`);
  }
}
