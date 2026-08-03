/**
 * F258 Phase B -- Star Card Store Tests
 *
 * Tests for thread metadata + star selection in the presence store.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { useVisibleCafePresenceStore } from '../../../stores/visible-cafe-presence';
import type { ThreadMeta } from '../presence-types';

describe('visible-cafe-presence store (Phase B additions)', () => {
  afterEach(() => {
    useVisibleCafePresenceStore.getState().reset();
  });

  // ── Thread Metadata ──

  it('stores thread metadata from reconcile', () => {
    const metas: ThreadMeta[] = [
      { threadId: 'thread_a', title: 'Thread A', lastActiveAt: 1000, participants: ['opus'] },
      { threadId: 'thread_b', title: 'Thread B', lastActiveAt: 2000, participants: ['codex'] },
    ];

    useVisibleCafePresenceStore.getState().setThreadMetas(metas);

    const stored = useVisibleCafePresenceStore.getState().threadMetas;
    expect(stored.size).toBe(2);
    expect(stored.get('thread_a')?.title).toBe('Thread A');
    expect(stored.get('thread_b')?.participants).toEqual(['codex']);
  });

  it('replaces old metas on each reconcile', () => {
    const metas1: ThreadMeta[] = [{ threadId: 'thread_a', title: 'Old', lastActiveAt: 1000, participants: [] }];
    const metas2: ThreadMeta[] = [
      { threadId: 'thread_a', title: 'New', lastActiveAt: 2000, participants: [] },
      { threadId: 'thread_c', title: 'C', lastActiveAt: 3000, participants: [] },
    ];

    useVisibleCafePresenceStore.getState().setThreadMetas(metas1);
    expect(useVisibleCafePresenceStore.getState().threadMetas.size).toBe(1);

    useVisibleCafePresenceStore.getState().setThreadMetas(metas2);
    const stored = useVisibleCafePresenceStore.getState().threadMetas;
    expect(stored.size).toBe(2);
    expect(stored.get('thread_a')?.title).toBe('New');
    expect(stored.has('thread_c')).toBe(true);
  });

  // ── Star Selection ──

  it('starts with no star selected', () => {
    expect(useVisibleCafePresenceStore.getState().selectedStarThreadId).toBeNull();
  });

  it('selects a star', () => {
    useVisibleCafePresenceStore.getState().selectStar('thread_xyz');
    expect(useVisibleCafePresenceStore.getState().selectedStarThreadId).toBe('thread_xyz');
  });

  it('deselects a star with null', () => {
    useVisibleCafePresenceStore.getState().selectStar('thread_xyz');
    useVisibleCafePresenceStore.getState().selectStar(null);
    expect(useVisibleCafePresenceStore.getState().selectedStarThreadId).toBeNull();
  });

  it('replaces selection when clicking another star', () => {
    useVisibleCafePresenceStore.getState().selectStar('thread_a');
    useVisibleCafePresenceStore.getState().selectStar('thread_b');
    expect(useVisibleCafePresenceStore.getState().selectedStarThreadId).toBe('thread_b');
  });

  // ── Reset ──

  it('reset clears thread metas and selection', () => {
    useVisibleCafePresenceStore
      .getState()
      .setThreadMetas([{ threadId: 'thread_a', title: 'A', lastActiveAt: 1000, participants: [] }]);
    useVisibleCafePresenceStore.getState().selectStar('thread_a');

    useVisibleCafePresenceStore.getState().reset();

    expect(useVisibleCafePresenceStore.getState().threadMetas.size).toBe(0);
    expect(useVisibleCafePresenceStore.getState().selectedStarThreadId).toBeNull();
  });
});
