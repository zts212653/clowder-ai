/**
 * F258 Phase B -- Star Card Mapping Tests
 *
 * Tests for deriveStarCardSnapshot: per-thread posture derivation.
 * U1 red line: each call maps ONE thread -- never aggregate.
 */

import { describe, expect, it } from 'vitest';
import { deriveStarCardSnapshot } from '../event-mapping';
import type { ThreadMeta } from '../presence-types';

const NOW = 1_700_000_000_000;

function makeMeta(overrides: Partial<ThreadMeta> = {}): ThreadMeta {
  return {
    threadId: 'thread_abc123',
    title: 'Test Thread',
    lastActiveAt: NOW - 10_000, // 10 seconds ago
    participants: ['opus'],
    ...overrides,
  };
}

describe('deriveStarCardSnapshot', () => {
  // ── Posture derivation ──

  it('returns working for thread active within 30s', () => {
    const meta = makeMeta({ lastActiveAt: NOW - 5_000 }); // 5s ago
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.posture).toBe('working');
    expect(card.state).toBe('live');
  });

  it('returns working at exactly 0 age', () => {
    const meta = makeMeta({ lastActiveAt: NOW });
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.posture).toBe('working');
    expect(card.state).toBe('live');
  });

  it('returns idle for thread active between 30s and 2min', () => {
    const meta = makeMeta({ lastActiveAt: NOW - 60_000 }); // 1 min ago
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.posture).toBe('idle');
    expect(card.state).toBe('live');
  });

  it('returns sleeping for thread active > 2min ago', () => {
    const meta = makeMeta({ lastActiveAt: NOW - 180_000 }); // 3 min ago
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.posture).toBe('sleeping');
    expect(card.state).toBe('stale');
  });

  it('returns sleeping+unknown for very old activity (> 5min)', () => {
    const meta = makeMeta({ lastActiveAt: NOW - 600_000 }); // 10 min ago
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.posture).toBe('sleeping');
    expect(card.state).toBe('unknown');
  });

  it('returns sleeping+unknown for zero lastActiveAt', () => {
    const meta = makeMeta({ lastActiveAt: 0 });
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.posture).toBe('sleeping');
    expect(card.state).toBe('unknown');
  });

  // ── Boundary conditions ──

  it('transitions working->idle at exactly 30s', () => {
    const meta = makeMeta({ lastActiveAt: NOW - 30_000 });
    const card = deriveStarCardSnapshot(meta, NOW);
    // At exactly the threshold, age >= WORKING_THRESHOLD so idle
    expect(card.posture).toBe('idle');
  });

  it('transitions idle->sleeping at exactly 2min', () => {
    const meta = makeMeta({ lastActiveAt: NOW - 120_000 });
    const card = deriveStarCardSnapshot(meta, NOW);
    // At exactly the threshold, age >= IDLE_THRESHOLD so sleeping
    expect(card.posture).toBe('sleeping');
  });

  // ── U1: Single thread isolation ──

  it('produces one card per call -- no cross-thread leakage', () => {
    const metaA = makeMeta({ threadId: 'thread_a', title: 'Thread A', lastActiveAt: NOW });
    const metaB = makeMeta({ threadId: 'thread_b', title: 'Thread B', lastActiveAt: NOW - 300_000 });

    const cardA = deriveStarCardSnapshot(metaA, NOW);
    const cardB = deriveStarCardSnapshot(metaB, NOW);

    expect(cardA.threadId).toBe('thread_a');
    expect(cardA.posture).toBe('working');
    expect(cardB.threadId).toBe('thread_b');
    expect(cardB.posture).toBe('sleeping');
    // Each card is independent -- A's state doesn't affect B
  });

  // ── Cat binding (preferredCats > participants fallback) ──

  it('binds catId from preferredCats when available', () => {
    const meta = makeMeta({ preferredCats: ['fable-5'], participants: ['codex', 'opus'] });
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.catId).toBe('fable-5');
  });

  it('falls back to first participant when no preferredCats', () => {
    const meta = makeMeta({ participants: ['codex', 'opus'] });
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.catId).toBe('codex');
  });

  it('falls back to first participant when preferredCats is empty', () => {
    const meta = makeMeta({ preferredCats: [], participants: ['opus'] });
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.catId).toBe('opus');
  });

  it('uses unknown for empty participants and no preferredCats', () => {
    const meta = makeMeta({ participants: [] });
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.catId).toBe('unknown');
  });

  // ── Provenance ──

  it('includes thread-scoped sourceRef', () => {
    const meta = makeMeta({ threadId: 'thread_xyz', lastActiveAt: 12345 });
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.sourceRef).toBe('reconcile:thread:thread_xyz:12345');
  });

  // ── Title passthrough ──

  it('passes title through', () => {
    const meta = makeMeta({ title: 'My Cool Thread' });
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.title).toBe('My Cool Thread');
  });

  it('handles null title', () => {
    const meta = makeMeta({ title: null });
    const card = deriveStarCardSnapshot(meta, NOW);
    expect(card.title).toBeNull();
  });
});
