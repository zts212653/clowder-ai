/**
 * F173 A.3 — deriveBubbleId unit tests.
 *
 * deterministic ID by (invocationId, catId) — eliminates dual-handler ID drift.
 */

import { describe, expect, it, vi } from 'vitest';
import { deriveBubbleId } from '@/debug/bubbleIdentity';

describe('F173 A.3 — deriveBubbleId', () => {
  it('returns deterministic id when both invocationId and catId are known', () => {
    const fallback = vi.fn(() => 'fallback-id');
    const id = deriveBubbleId('inv-1', 'gpt52', fallback);
    expect(id).toBe('msg-inv-1-gpt52');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('two handlers given the same (invocationId, catId) derive the SAME id', () => {
    // This is the core invariant — eliminates ghost bubble dual-creation.
    const activeId = deriveBubbleId('inv-1', 'gpt52', () => 'msg-active-fallback');
    const bgId = deriveBubbleId('inv-1', 'gpt52', () => 'bg-fallback-fallback');
    expect(activeId).toBe(bgId);
  });

  it('falls back to caller-supplied id when invocationId is undefined', () => {
    const fallback = vi.fn(() => 'fallback-id');
    const id = deriveBubbleId(undefined, 'gpt52', fallback);
    expect(id).toBe('fallback-id');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('falls back when invocationId is null', () => {
    const id = deriveBubbleId(null, 'gpt52', () => 'fallback');
    expect(id).toBe('fallback');
  });

  it('falls back when catId is undefined', () => {
    const id = deriveBubbleId('inv-1', undefined, () => 'fallback');
    expect(id).toBe('fallback');
  });

  it('different invocations yield different ids (dedup invariant)', () => {
    const a = deriveBubbleId('inv-1', 'gpt52', () => 'fa');
    const b = deriveBubbleId('inv-2', 'gpt52', () => 'fb');
    expect(a).not.toBe(b);
  });

  it('different cats in same invocation yield different ids', () => {
    const a = deriveBubbleId('inv-1', 'gpt52', () => 'fa');
    const b = deriveBubbleId('inv-1', 'opus', () => 'fb');
    expect(a).not.toBe(b);
  });
});
