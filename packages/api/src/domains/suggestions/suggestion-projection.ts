import { SUGGESTION_STALE_TRANSITION_MS, type SuggestionEventType, type SuggestionView } from '@cat-cafe/shared';
import type { SuggestionRecord } from './SuggestionStore.js';

/** A receipt that undoes nothing (「已向小星星补了一条先例」) has no registered action. */
export const PLAIN_RECEIPT_KIND = 'receipt';
export const PLAIN_RECEIPT_LABEL = '回执';
/** A click that never settled (process killed mid-apply) stops blocking the row after this long. */
export const STALE_TRANSITION_MS = SUGGESTION_STALE_TRANSITION_MS;

export function withEvent(record: SuggestionRecord, type: SuggestionEventType, at: number): SuggestionRecord['events'] {
  return [...record.events, { type, at }];
}

export function countEvents(record: SuggestionRecord, type: SuggestionEventType): number {
  return record.events.filter((event) => event.type === type).length;
}

/**
 * Lazy facts: a click that never settled reads as its starting state; then an open row past its expiry is ignored
 * (so a pill left mid-click by a killed process still expires).
 */
export function effectiveSuggestion(record: SuggestionRecord, now: number): SuggestionRecord {
  let effective = record;
  if (record.state === 'applying' && now - record.updatedAt >= STALE_TRANSITION_MS) {
    effective = { ...record, state: 'open' };
  } else if (record.state === 'undoing' && now - record.updatedAt >= STALE_TRANSITION_MS) {
    effective = { ...record, state: 'applied' };
  }
  if (effective.state === 'open' && now >= effective.expiresAt) {
    return { ...effective, state: 'ignored', events: withEvent(effective, 'ignored', effective.expiresAt) };
  }
  return effective;
}

/** The row as the web draws it; action params and applied references stay on the server. */
export function toSuggestionView(record: SuggestionRecord): SuggestionView {
  return {
    id: record.id,
    threadId: record.threadId,
    messageId: record.messageId,
    catId: record.catId,
    byline: record.byline,
    kind: record.kind,
    kindLabel: record.kindLabel,
    label: record.label,
    state: record.state,
    ...(record.receipt ? { receipt: record.receipt } : {}),
    ...(record.watcherSupplement ? { watcherSupplement: record.watcherSupplement } : {}),
    undo: record.undo,
    receiptOnly: record.receiptOnly,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
  };
}
