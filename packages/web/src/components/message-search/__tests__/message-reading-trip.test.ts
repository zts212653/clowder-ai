import type { MessageSearchResponse } from '@cat-cafe/shared';
import { describe, expect, it } from 'vitest';
import {
  beginMessageReadingTrip,
  interruptMessageReadingTrip,
  requestMessageReadingReturn,
  requestMessageReadingTarget,
  settleMessageReadingTrip,
} from '../message-reading-trip';

const response = (): MessageSearchResponse => ({
  searchId: 'original-search',
  query: 'original question',
  results: [
    ['thread-a', 'first'],
    ['thread-a', 'second'],
    ['thread-b', 'third'],
  ].map(([threadId, messageId]) => ({
    threadId,
    messageId,
    threadTitle: 'Thread',
    speaker: 'codex61-sol',
    timestamp: 100,
    timelineOrderAt: 100,
    snippet: { text: 'do not persist this body', start: 0, end: 24, source: 'body' },
    highlights: [],
    match: 'lexical',
    contentRevision: 'revision',
    publiclyQuotable: true,
  })),
  meta: {
    scope: 'global',
    sort: 'time',
    requestedMode: 'hybrid',
    effectiveMode: 'lexical',
    degraded: true,
    degradeReason: 'embedding_unavailable',
    partial: false,
    hasMore: false,
    candidateLimit: 2000,
    semanticCandidatesLimited: false,
    sourceCoverage: 'unknown',
    freshness: 'unknown',
    response: { budgetChars: 24000, serializedChars: 1000, truncated: false, continuation: 'unavailable' },
  },
});

const origin = { threadId: 'original-thread', readingRef: 'opaque-owner-ref' };

function begin() {
  const trip = beginMessageReadingTrip(response(), origin);
  if (!trip) throw new Error('Valid result collection must begin a reading trip');
  return trip;
}

describe('message reading trip settlement', () => {
  it('captures immutable collection coordinates and origin only on the explicit opening action', () => {
    const source = response();
    const initialOrigin = { ...origin };
    const trip = beginMessageReadingTrip(source, initialOrigin);
    expect(trip).toMatchObject({ searchId: 'original-search', origin, settledIndex: null, pending: null });
    source.results[0].messageId = 'changed-after-opening';
    initialOrigin.readingRef = 'new-return-point';
    expect(trip?.targets[0]).toEqual({ threadId: 'thread-a', messageId: 'first', contentRevision: 'revision' });
    expect(trip?.origin).toEqual(origin);
    expect(JSON.stringify(trip)).not.toContain('do not persist this body');
    expect(JSON.parse(JSON.stringify(trip))).toEqual(trip);
  });

  it('advances n only after the matching exact-message receipt, even for hits in the same thread', () => {
    const first = requestMessageReadingTarget(begin(), 0);
    if (!first) throw new Error('Missing first intent');
    expect(first.trip.settledIndex).toBeNull();
    const settled = settleMessageReadingTrip(first.trip, first.effect, 'settled');
    expect(settled.settledIndex).toBe(0);
    const second = requestMessageReadingTarget(settled, 1);
    if (!second) throw new Error('Missing second intent');
    expect(second.effect).toMatchObject({ target: { threadId: 'thread-a', messageId: 'second' } });
    expect(second.trip.settledIndex).toBe(0);
    expect(settleMessageReadingTrip(second.trip, first.effect, 'settled')).toEqual(second.trip);
    expect(settleMessageReadingTrip(second.trip, second.effect, 'settled').settledIndex).toBe(1);
    expect(second.trip.origin).toEqual(origin);
  });

  it('rejects a substituted target even when its generation matches', () => {
    const requested = requestMessageReadingTarget(begin(), 0);
    if (!requested || requested.effect.kind !== 'target') throw new Error('Missing target intent');
    const forged = { ...requested.effect, target: { threadId: 'thread-a', messageId: 'second' } };
    expect(settleMessageReadingTrip(requested.trip, forged, 'settled')).toEqual(requested.trip);
  });

  it('keeps the original return action after a target disappears, and ends only on return settlement', () => {
    const requested = requestMessageReadingTarget(begin(), 2);
    if (!requested) throw new Error('Missing target intent');
    const unavailable = settleMessageReadingTrip(requested.trip, requested.effect, 'unavailable');
    expect(unavailable).toMatchObject({ status: 'unavailable', settledIndex: null, origin });
    const returning = requestMessageReadingReturn(unavailable);
    if (!returning) throw new Error('Missing return intent');
    expect(returning.trip.status).toBe('moving');
    expect(returning.effect).toMatchObject({ kind: 'return', origin });
    expect(settleMessageReadingTrip(returning.trip, requested.effect, 'settled')).toEqual(returning.trip);
    const failed = settleMessageReadingTrip(returning.trip, returning.effect, 'unavailable');
    expect(failed.origin).toEqual(origin);
    expect(requestMessageReadingReturn(failed)).not.toBeNull();
    const completed = settleMessageReadingTrip(returning.trip, returning.effect, 'settled');
    expect(completed.status).toBe('completed');
    expect(requestMessageReadingTarget(completed, 0)).toBeNull();
  });

  it('invalidates pending receipts when a newer gesture or navigation interrupts the intent', () => {
    const requested = requestMessageReadingTarget(begin(), 0);
    if (!requested) throw new Error('Missing target intent');
    const interrupted = interruptMessageReadingTrip(requested.trip);
    expect(interrupted).toMatchObject({ pending: null, status: 'interrupted', origin });
    expect(settleMessageReadingTrip(interrupted, requested.effect, 'settled')).toEqual(interrupted);
    const next = requestMessageReadingTarget(interrupted, 2);
    if (!next) throw new Error('Missing later intent');
    expect(next.effect.generation).toBeGreaterThan(requested.effect.generation);
  });

  it('does not create a trip for an empty collection or route past the bounded returned results', () => {
    expect(beginMessageReadingTrip({ ...response(), results: [] }, origin)).toBeNull();
    const trip = begin();
    for (const index of [-1, 3, 0.5, Number.NaN]) expect(requestMessageReadingTarget(trip, index)).toBeNull();
    expect(trip).toMatchObject({ generation: 0, settledIndex: null, pending: null });
  });
});
