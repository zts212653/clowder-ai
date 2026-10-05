import type { RecallResolverFamily } from '@cat-cafe/shared';
import type { MemoryCueEvent, MemoryCueInvalidationReason } from './MemoryCueEpisodeStore.js';

/**
 * F321 Phase A (A1): per-cue read projection for one invocation.
 *
 * Status semantics follow the Phase A design table — silence is never
 * reported as refusal: a cue with only `presented` is `presented_unreported`,
 * and `drilled` without a terminal outcome is `drilled` ("看过").
 */
export type MemoryCueInvocationStatus = 'applied' | 'dismissed' | 'drilled' | 'presented_unreported' | 'invalidated';

export interface MemoryCueInvocationCueEntry {
  cueId: string;
  resolverFamily: RecallResolverFamily;
  sourceAnchor: string;
  sourceRevision: string;
  consumerCatId: string;
  status: MemoryCueInvocationStatus;
  invalidationReason: MemoryCueInvalidationReason | null;
  presentedAt: number;
  lastEventAt: number;
}

export function projectInvocationCues(events: readonly MemoryCueEvent[]): MemoryCueInvocationCueEntry[] {
  const byCueId = new Map<string, MemoryCueEvent[]>();
  for (const event of events) {
    const list = byCueId.get(event.cueId);
    if (list) list.push(event);
    else byCueId.set(event.cueId, [event]);
  }

  const entries: MemoryCueInvocationCueEntry[] = [];
  for (const [cueId, cueEvents] of byCueId) {
    const first = cueEvents[0];
    if (!first) continue;

    let presentedAt: number | null = null;
    let lastEventAt = 0;
    let latestTerminal: MemoryCueEvent | null = null;
    let drilled = false;
    let latestInvalidation: MemoryCueEvent | null = null;

    for (const event of cueEvents) {
      if (event.occurredAt > lastEventAt) lastEventAt = event.occurredAt;
      if (event.axis === 'consumption') {
        if (event.consumptionOutcome === 'presented' && (presentedAt === null || event.occurredAt < presentedAt)) {
          presentedAt = event.occurredAt;
        }
        if (event.consumptionOutcome === 'drilled') drilled = true;
        if (
          (event.consumptionOutcome === 'applied' || event.consumptionOutcome === 'dismissed') &&
          (!latestTerminal || event.occurredAt >= latestTerminal.occurredAt)
        ) {
          latestTerminal = event;
        }
      } else if (!latestInvalidation || event.occurredAt >= latestInvalidation.occurredAt) {
        latestInvalidation = event;
      }
    }

    let status: MemoryCueInvocationStatus;
    let invalidationReason: MemoryCueInvalidationReason | null = null;
    if (latestInvalidation) {
      status = 'invalidated';
      invalidationReason = latestInvalidation.invalidationReason;
    } else if (latestTerminal?.consumptionOutcome === 'applied') {
      status = 'applied';
    } else if (latestTerminal?.consumptionOutcome === 'dismissed') {
      status = 'dismissed';
    } else if (drilled) {
      status = 'drilled';
    } else {
      status = 'presented_unreported';
    }

    entries.push({
      cueId,
      resolverFamily: first.resolverFamily,
      sourceAnchor: first.sourceAnchor,
      sourceRevision: first.sourceRevision,
      consumerCatId: first.consumerCatId,
      status,
      invalidationReason,
      presentedAt: presentedAt ?? first.occurredAt,
      lastEventAt,
    });
  }

  entries.sort((a, b) => a.presentedAt - b.presentedAt || a.cueId.localeCompare(b.cueId));
  return entries;
}
