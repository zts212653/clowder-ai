import type { MessageSearchResponse } from '@cat-cafe/shared';
import type { ChatReadingRef } from '@/utils/chat-scroll-memory';

export interface MessageReadingTarget {
  readonly threadId: string;
  readonly messageId: string;
  readonly contentRevision?: string;
}

export interface MessageReadingTrip {
  searchId: string;
  origin: Readonly<{ threadId: string; readingRef: ChatReadingRef }>;
  targets: readonly MessageReadingTarget[];
  generation: number;
  settledIndex: number | null;
  pending: { kind: 'target'; index: number } | { kind: 'return' } | null;
  status: 'ready' | 'moving' | 'unavailable' | 'interrupted' | 'completed';
}

export type MessageReadingEffect =
  | { kind: 'target'; generation: number; target: MessageReadingTarget }
  | { kind: 'return'; generation: number; origin: MessageReadingTrip['origin'] };

export function beginMessageReadingTrip(
  response: MessageSearchResponse,
  origin: MessageReadingTrip['origin'],
): MessageReadingTrip | null {
  if (!response.results.length || !origin.threadId || !origin.readingRef) return null;
  return {
    searchId: response.searchId,
    origin: { ...origin },
    targets: response.results.map(({ threadId, messageId, contentRevision }) => ({
      threadId,
      messageId,
      contentRevision,
    })),
    generation: 0,
    settledIndex: null,
    pending: null,
    status: 'ready',
  };
}

export function requestMessageReadingTarget(
  trip: MessageReadingTrip,
  index: number,
): { trip: MessageReadingTrip; effect: MessageReadingEffect } | null {
  if (trip.status === 'completed' || !Number.isInteger(index) || index < 0) return null;
  const target = trip.targets[index];
  if (!target) return null;
  const generation = trip.generation + 1;
  return {
    trip: { ...trip, generation, pending: { kind: 'target', index }, status: 'moving' },
    effect: { kind: 'target', generation, target: { ...target } },
  };
}

export function requestMessageReadingReturn(
  trip: MessageReadingTrip,
): { trip: MessageReadingTrip; effect: MessageReadingEffect } | null {
  if (trip.status === 'completed') return null;
  const generation = trip.generation + 1;
  return {
    trip: { ...trip, generation, pending: { kind: 'return' }, status: 'moving' },
    effect: { kind: 'return', generation, origin: { ...trip.origin } },
  };
}

function matchesPending(trip: MessageReadingTrip, effect: MessageReadingEffect): boolean {
  if (!trip.pending || trip.generation !== effect.generation || trip.pending.kind !== effect.kind) return false;
  if (effect.kind === 'return') {
    return effect.origin.threadId === trip.origin.threadId && effect.origin.readingRef === trip.origin.readingRef;
  }
  if (trip.pending.kind !== 'target') return false;
  const target = trip.targets[trip.pending.index];
  return target?.threadId === effect.target.threadId && target?.messageId === effect.target.messageId;
}

export function settleMessageReadingTrip(
  trip: MessageReadingTrip,
  effect: MessageReadingEffect,
  status: 'settled' | 'unavailable' | 'interrupted',
): MessageReadingTrip {
  if (!matchesPending(trip, effect)) return trip;
  if (status !== 'settled') return { ...trip, pending: null, status };
  if (trip.pending?.kind === 'target') {
    return { ...trip, settledIndex: trip.pending.index, pending: null, status: 'ready' };
  }
  return { ...trip, pending: null, status: 'completed' };
}

export function interruptMessageReadingTrip(trip: MessageReadingTrip): MessageReadingTrip {
  if (trip.status === 'completed') return trip;
  return { ...trip, generation: trip.generation + 1, pending: null, status: 'interrupted' };
}
