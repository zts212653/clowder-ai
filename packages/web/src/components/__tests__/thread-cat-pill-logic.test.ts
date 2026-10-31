/**
 * F154 Phase B — Pure function tests for ThreadCatPill logic.
 * P1-1: enforceSingleSelect (KD-5 single-cat mode)
 * P2-2: computePopoverPosition (right-edge clamp)
 *
 * Separated from thread-cat-pill.test.ts to avoid jsdom/React DOM rendering
 * which triggers Node.js 25 worker OOM on this machine.
 */
import { describe, expect, it } from 'vitest';
import { computePopoverPosition, enforceSingleSelect } from '../ThreadCatPill';

describe('enforceSingleSelect (P1-1, KD-5)', () => {
  it('keeps single selection unchanged', () => {
    expect(enforceSingleSelect(['codex'], ['opus'])).toEqual(['codex']);
  });

  it('replaces old selection with newly added cat', () => {
    // User had opus selected, then clicked codex → CatSelector returns ['opus', 'codex']
    expect(enforceSingleSelect(['opus', 'codex'], ['opus'])).toEqual(['codex']);
  });

  it('handles deselecting all cats', () => {
    expect(enforceSingleSelect([], ['opus'])).toEqual([]);
  });

  it('handles selecting from empty (first selection)', () => {
    expect(enforceSingleSelect(['opus'], [])).toEqual(['opus']);
  });

  it('handles three cats: keeps only the newly added one', () => {
    // Edge case: somehow 3 arrive (shouldn't happen with toggle but defensive)
    expect(enforceSingleSelect(['opus', 'codex', 'gemini'], ['opus', 'codex'])).toEqual(['gemini']);
  });

  it('falls back to last element if no new cat detected', () => {
    // All cats already in current → pick last
    expect(enforceSingleSelect(['opus', 'codex'], ['opus', 'codex'])).toEqual(['codex']);
  });
});

describe('computePopoverPosition (P2-2)', () => {
  it('positions below pill with left aligned', () => {
    const result = computePopoverPosition({ bottom: 50, left: 100 }, 1200);
    expect(result.top).toBe(56); // bottom + 6
    expect(result.left).toBe(100);
    expect(result.width).toBe(280);
  });

  it('clamps left edge to 8px minimum', () => {
    const result = computePopoverPosition({ bottom: 50, left: 2 }, 1200);
    expect(result.left).toBe(8);
  });

  it('clamps right edge when pill is near viewport right (P2-2 fix)', () => {
    // Pill at left: 1000, width: 280 → right edge would be 1280, viewport is 1024
    const result = computePopoverPosition({ bottom: 50, left: 1000 }, 1024);
    expect(result.left).toBe(1024 - 280 - 8); // 736
  });

  it('handles narrow viewport: right-edge clamp takes precedence', () => {
    // Pill at left: 30, viewport 300 → rightEdge=310 > 292 → clamp to 12
    const result = computePopoverPosition({ bottom: 50, left: 30 }, 300);
    expect(result.left).toBe(300 - 280 - 8); // 12
  });
});
