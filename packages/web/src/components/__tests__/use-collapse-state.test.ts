import { describe, expect, it } from 'vitest';
import {
  collapseAllGroups,
  expandAllGroups,
  findGroupKeyForThread,
  initCollapsedSet,
  readCollapsedGroups,
  resolveCollapse,
  STORAGE_KEY,
  type StorageLike,
  shouldCollapse,
  shouldCollapseBeforeInit,
  writeCollapsedGroups,
} from '../ThreadSidebar/collapse-state';

/** In-memory storage mock (no jsdom dependency). */
function createMockStorage(): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  };
}

const ALL_KEYS = ['pinned', '/proj/cat-cafe', '/proj/dare', 'favorites'];

// ── initCollapsedSet ──────────────────────────────────

describe('initCollapsedSet', () => {
  // AC-A3: First visit — all groups collapsed by default
  it('defaults to all groups collapsed on first visit (no storage)', () => {
    const storage = createMockStorage();
    const set = initCollapsedSet(ALL_KEYS, storage);
    expect(set.size).toBe(4);
    for (const key of ALL_KEYS) {
      expect(set.has(key)).toBe(true);
    }
  });

  // AC-A1: Restores state from storage
  it('restores collapsed state from storage on init', () => {
    const storage = createMockStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(['pinned']));
    const set = initCollapsedSet(ALL_KEYS, storage);
    expect(set.has('pinned')).toBe(true);
    expect(set.has('/proj/cat-cafe')).toBe(false);
    expect(set.has('/proj/dare')).toBe(false);
  });

  // Graceful degradation
  it('falls back to default when storage has invalid data', () => {
    const storage = createMockStorage();
    storage.setItem(STORAGE_KEY, 'not-json');
    const set = initCollapsedSet(ALL_KEYS, storage);
    expect(set.size).toBe(4);
  });

  it('falls back to default when storage has non-array JSON', () => {
    const storage = createMockStorage();
    storage.setItem(STORAGE_KEY, '{"a":1}');
    const set = initCollapsedSet(ALL_KEYS, storage);
    expect(set.size).toBe(4);
  });

  it('falls back to default when storage has mixed-type array', () => {
    const storage = createMockStorage();
    storage.setItem(STORAGE_KEY, '[1, "pinned", null]');
    const set = initCollapsedSet(ALL_KEYS, storage);
    expect(set.size).toBe(4);
  });
});

// ── writeCollapsedGroups + readCollapsedGroups ─────────

describe('persistence round-trip', () => {
  // AC-A4: storage key has namespace prefix
  it('uses namespaced key cat-cafe:sidebar:collapsed-groups', () => {
    const storage = createMockStorage();
    writeCollapsedGroups(['pinned', '/proj/dare'], storage);
    const raw = storage.store.get(STORAGE_KEY);
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)).toEqual(['pinned', '/proj/dare']);
  });

  it('readCollapsedGroups returns what writeCollapsedGroups stored', () => {
    const storage = createMockStorage();
    writeCollapsedGroups(['/proj/cat-cafe'], storage);
    const result = readCollapsedGroups(storage);
    expect(result).toEqual(['/proj/cat-cafe']);
  });

  it('readCollapsedGroups returns null when nothing stored', () => {
    const storage = createMockStorage();
    expect(readCollapsedGroups(storage)).toBeNull();
  });
});

// ── shouldCollapse ────────────────────────────────────

describe('shouldCollapse', () => {
  // AC-A5: Search forces all groups expanded
  it('returns false for all groups when searchQuery is non-empty', () => {
    const collapsed = new Set(ALL_KEYS);
    for (const key of ALL_KEYS) {
      expect(shouldCollapse(key, collapsed, 'cat')).toBe(false);
    }
  });

  it('returns true for collapsed groups when no search', () => {
    const collapsed = new Set(['pinned', '/proj/dare']);
    expect(shouldCollapse('pinned', collapsed, '')).toBe(true);
    expect(shouldCollapse('/proj/dare', collapsed, '')).toBe(true);
    expect(shouldCollapse('/proj/cat-cafe', collapsed, '')).toBe(false);
  });

  it('returns false for groups not in collapsed set', () => {
    const collapsed = new Set<string>();
    expect(shouldCollapse('pinned', collapsed, '')).toBe(false);
  });
});

// ── findGroupKeyForThread ─────────────────────────────

describe('findGroupKeyForThread', () => {
  const groups = [
    { groupKey: 'pinned', threadIds: ['p1'] },
    { groupKey: '/proj/cat-cafe', threadIds: ['t1', 't2'] },
    { groupKey: '/proj/dare', threadIds: ['t3'] },
    { groupKey: 'favorites', threadIds: ['f1'] },
  ];

  // AC-A6: Find group containing active thread
  it('finds the group containing the given thread', () => {
    expect(findGroupKeyForThread('t1', groups)).toBe('/proj/cat-cafe');
    expect(findGroupKeyForThread('p1', groups)).toBe('pinned');
    expect(findGroupKeyForThread('f1', groups)).toBe('favorites');
  });

  it('returns undefined for unknown thread', () => {
    expect(findGroupKeyForThread('unknown', groups)).toBeUndefined();
  });

  // clowder-ai#89: thread in both recent + project should prefer project
  it('prefers project group over recent when thread appears in both', () => {
    const groupsWithRecent = [
      { groupKey: 'pinned', threadIds: ['p1'], type: 'pinned' as const },
      { groupKey: 'recent', threadIds: ['t1', 't3'], type: 'recent' as const },
      { groupKey: '/proj/cat-cafe', threadIds: ['t1', 't2'], type: 'project' as const },
      { groupKey: '/proj/dare', threadIds: ['t3'], type: 'project' as const },
    ];
    // t1 is in both recent and /proj/cat-cafe → should return project
    expect(findGroupKeyForThread('t1', groupsWithRecent)).toBe('/proj/cat-cafe');
    // t3 is in both recent and /proj/dare → should return project
    expect(findGroupKeyForThread('t3', groupsWithRecent)).toBe('/proj/dare');
  });

  it('falls back to recent if thread is only in recent', () => {
    const groupsWithRecent = [
      { groupKey: 'recent', threadIds: ['r1'], type: 'recent' as const },
      { groupKey: '/proj/cat-cafe', threadIds: ['t1'], type: 'project' as const },
    ];
    expect(findGroupKeyForThread('r1', groupsWithRecent)).toBe('recent');
  });
});

// ── AC-A7: expandAll / collapseAll (pure function level) ──

describe('expandAllGroups / collapseAllGroups', () => {
  it('expandAllGroups returns empty set', () => {
    expect(expandAllGroups().size).toBe(0);
  });

  it('collapseAllGroups collapses ALL known keys, not just filtered subset', () => {
    const allKnown = ['pinned', '/proj/cat-cafe', '/proj/dare', 'favorites'];
    const filteredVisible = ['pinned', '/proj/cat-cafe']; // simulates search filter

    // The bug: using filteredVisible would miss /proj/dare and favorites
    const result = collapseAllGroups(allKnown);
    expect(result.size).toBe(4);
    for (const key of allKnown) {
      expect(result.has(key)).toBe(true);
    }

    // Contrast: using only filtered keys is wrong
    const wrong = collapseAllGroups(filteredVisible);
    expect(wrong.size).toBe(2); // only 2, not 4
  });
});

// ── P2-1: Default collapse before initialization ─────

describe('shouldCollapseBeforeInit', () => {
  it('returns true (collapsed) for any group before storage is read', () => {
    // Before init, everything should appear collapsed to prevent flicker
    expect(shouldCollapseBeforeInit('pinned')).toBe(true);
    expect(shouldCollapseBeforeInit('/proj/cat-cafe')).toBe(true);
    expect(shouldCollapseBeforeInit('unknown-group')).toBe(true);
  });
});

// ── Cloud review: search overrides pre-init default (resolveCollapse) ──

describe('resolveCollapse (hook-equivalent logic)', () => {
  it('returns false (expanded) when search is active, even before init', () => {
    // Pre-init + active search: search must win over default-collapsed
    // This exercises the exact code path in the hook's isCollapsed callback
    for (const key of ALL_KEYS) {
      expect(resolveCollapse(key, new Set(), 'cat', false)).toBe(false);
    }
  });

  it('returns true (collapsed) before init when no search', () => {
    for (const key of ALL_KEYS) {
      expect(resolveCollapse(key, new Set(), '', false)).toBe(true);
    }
  });

  it('delegates to shouldCollapse after init', () => {
    const collapsed = new Set(['pinned']);
    expect(resolveCollapse('pinned', collapsed, '', true)).toBe(true);
    expect(resolveCollapse('/proj/cat-cafe', collapsed, '', true)).toBe(false);
    // search still wins post-init
    expect(resolveCollapse('pinned', collapsed, 'cat', true)).toBe(false);
  });
});

// ── AC-A2: Independent group state ────────────────────

describe('independent group collapse', () => {
  it('toggle one group does not affect others (via Set operations)', () => {
    const storage = createMockStorage();
    const collapsed = initCollapsedSet(ALL_KEYS, storage);
    // Simulate expanding cat-cafe
    collapsed.delete('/proj/cat-cafe');
    expect(collapsed.has('/proj/cat-cafe')).toBe(false);
    expect(collapsed.has('pinned')).toBe(true);
    expect(collapsed.has('/proj/dare')).toBe(true);
    expect(collapsed.has('favorites')).toBe(true);

    // Simulate re-collapsing cat-cafe
    collapsed.add('/proj/cat-cafe');
    expect(collapsed.has('/proj/cat-cafe')).toBe(true);
  });
});
