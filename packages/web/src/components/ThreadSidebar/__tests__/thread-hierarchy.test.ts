import { describe, expect, it } from 'vitest';
import type { Thread } from '@/stores/chatStore';
import { buildChildMap, getRootThreads, readHierarchyExpanded, writeHierarchyExpanded } from '../thread-hierarchy';

function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    projectPath: '/test',
    title: overrides.id,
    createdBy: 'opus',
    participants: ['opus'],
    lastActiveAt: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('buildChildMap', () => {
  it('returns empty map when no threads have parentThreadId', () => {
    const threads = [makeThread({ id: 'a' }), makeThread({ id: 'b' })];
    const map = buildChildMap(threads);
    expect(map.size).toBe(0);
  });

  it('groups children under parent IDs', () => {
    const threads = [
      makeThread({ id: 'parent' }),
      makeThread({ id: 'child1', parentThreadId: 'parent', lastActiveAt: 100 }),
      makeThread({ id: 'child2', parentThreadId: 'parent', lastActiveAt: 200 }),
    ];
    const map = buildChildMap(threads);
    expect(map.size).toBe(1);
    expect(map.get('parent')?.map((t) => t.id)).toEqual(['child2', 'child1']);
  });

  it('sorts children by lastActiveAt descending', () => {
    const threads = [
      makeThread({ id: 'p' }),
      makeThread({ id: 'c1', parentThreadId: 'p', lastActiveAt: 10 }),
      makeThread({ id: 'c2', parentThreadId: 'p', lastActiveAt: 30 }),
      makeThread({ id: 'c3', parentThreadId: 'p', lastActiveAt: 20 }),
    ];
    const map = buildChildMap(threads);
    expect(map.get('p')?.map((t) => t.id)).toEqual(['c2', 'c3', 'c1']);
  });

  it('handles multiple parents', () => {
    const threads = [
      makeThread({ id: 'p1' }),
      makeThread({ id: 'p2' }),
      makeThread({ id: 'c1', parentThreadId: 'p1' }),
      makeThread({ id: 'c2', parentThreadId: 'p2' }),
      makeThread({ id: 'c3', parentThreadId: 'p1' }),
    ];
    const map = buildChildMap(threads);
    expect(map.size).toBe(2);
    expect(map.get('p1')?.length).toBe(2);
    expect(map.get('p2')?.length).toBe(1);
  });

  it('excludes children whose parent is not in the set (P1 orphan fix)', () => {
    // Parent 'deleted-parent' is not in the thread list
    const threads = [makeThread({ id: 'orphan', parentThreadId: 'deleted-parent' }), makeThread({ id: 'other' })];
    const map = buildChildMap(threads);
    expect(map.size).toBe(0); // orphan should NOT be nested
  });

  it('excludes pinned children from nesting (P2 fix)', () => {
    const threads = [
      makeThread({ id: 'parent' }),
      makeThread({ id: 'pinned-child', parentThreadId: 'parent', pinned: true }),
      makeThread({ id: 'normal-child', parentThreadId: 'parent' }),
    ];
    const map = buildChildMap(threads);
    expect(map.get('parent')?.map((t) => t.id)).toEqual(['normal-child']);
  });

  it('excludes favorited children from nesting (P2 fix)', () => {
    const threads = [
      makeThread({ id: 'parent' }),
      makeThread({ id: 'fav-child', parentThreadId: 'parent', favorited: true }),
    ];
    const map = buildChildMap(threads);
    expect(map.size).toBe(0); // no children to nest
  });
});

describe('getRootThreads', () => {
  it('returns all threads when none have parentThreadId', () => {
    const threads = [makeThread({ id: 'a' }), makeThread({ id: 'b' })];
    expect(getRootThreads(threads)).toHaveLength(2);
  });

  it('filters out child threads whose parent exists', () => {
    const threads = [
      makeThread({ id: 'parent' }),
      makeThread({ id: 'child', parentThreadId: 'parent' }),
      makeThread({ id: 'other' }),
    ];
    const roots = getRootThreads(threads);
    expect(roots.map((t) => t.id)).toEqual(['parent', 'other']);
  });

  it('promotes orphan children to root when parent is missing (P1 fix)', () => {
    const threads = [makeThread({ id: 'orphan', parentThreadId: 'deleted-parent' }), makeThread({ id: 'other' })];
    const roots = getRootThreads(threads);
    expect(roots.map((t) => t.id)).toEqual(['orphan', 'other']);
  });

  it('promotes pinned children to root (P2 fix)', () => {
    const threads = [
      makeThread({ id: 'parent' }),
      makeThread({ id: 'pinned-child', parentThreadId: 'parent', pinned: true }),
      makeThread({ id: 'normal-child', parentThreadId: 'parent' }),
    ];
    const roots = getRootThreads(threads);
    expect(roots.map((t) => t.id)).toEqual(['parent', 'pinned-child']);
  });

  it('promotes favorited children to root (P2 fix)', () => {
    const threads = [
      makeThread({ id: 'parent' }),
      makeThread({ id: 'fav-child', parentThreadId: 'parent', favorited: true }),
    ];
    const roots = getRootThreads(threads);
    expect(roots.map((t) => t.id)).toEqual(['parent', 'fav-child']);
  });
});

describe('hierarchy localStorage persistence', () => {
  it('reads empty set from empty storage', () => {
    const storage = { getItem: () => null, setItem: () => {} };
    expect(readHierarchyExpanded(storage).size).toBe(0);
  });

  it('round-trips expanded state', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
    };
    const expanded = new Set(['t1', 't2']);
    writeHierarchyExpanded(expanded, storage);
    const result = readHierarchyExpanded(storage);
    expect(result).toEqual(expanded);
  });

  it('handles corrupted storage gracefully', () => {
    const storage = { getItem: () => 'not-json[[[', setItem: () => {} };
    expect(readHierarchyExpanded(storage).size).toBe(0);
  });
});
