import { describe, expect, it } from 'vitest';
import {
  createSidebarTabState,
  readPreferredSidebarTab,
  SIDEBAR_TAB_STORAGE_KEY,
  sidebarTabReducer,
  writePreferredSidebarTab,
} from '../sidebar-tab-state';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    value: (key: string) => values.get(key),
  };
}

describe('sidebarTabReducer', () => {
  it('keeps user-selected tabs as the durable preference', () => {
    const next = sidebarTabReducer(createSidebarTabState('recent'), {
      type: 'user-selected-tab',
      tab: 'pinned',
      filterKey: '',
    });

    expect(next.activeTab).toBe('pinned');
    expect(next.preferredTab).toBe('pinned');
  });

  it('does not override a user selection when thread data resolves later', () => {
    const selected = sidebarTabReducer(createSidebarTabState('recent'), {
      type: 'user-selected-tab',
      tab: 'pinned',
      filterKey: '',
    });
    const afterThreadLoad = sidebarTabReducer(selected, {
      type: 'initial-thread-reconciled',
      visibleInActiveTab: false,
      destinationTab: 'project',
    });

    expect(afterThreadLoad.activeTab).toBe('pinned');
  });

  it('keeps the user-selected tab across real thread navigation', () => {
    const initial = sidebarTabReducer(createSidebarTabState('recent'), {
      type: 'initial-thread-reconciled',
      visibleInActiveTab: true,
      destinationTab: 'recent',
    });
    const pinned = sidebarTabReducer(initial, {
      type: 'user-selected-tab',
      tab: 'pinned',
      filterKey: '',
    });
    const returned = sidebarTabReducer(pinned, {
      type: 'initial-thread-reconciled',
      visibleInActiveTab: false,
      destinationTab: 'project',
    });

    expect(returned.initialThreadResolved).toBe(true);
    expect(returned.activeTab).toBe('pinned');
  });

  it('switches only once for a filter key and restores the preferred tab when cleared', () => {
    const preferred = sidebarTabReducer(createSidebarTabState('recent'), {
      type: 'user-selected-tab',
      tab: 'favorites',
      filterKey: '',
    });
    const filtered = sidebarTabReducer(preferred, {
      type: 'filter-reconciled',
      filterKey: '["system",null]',
      activeTabHasThreads: false,
      firstNonEmptyTab: 'system',
    });
    const membershipChanged = sidebarTabReducer(filtered, {
      type: 'filter-reconciled',
      filterKey: '["system",null]',
      activeTabHasThreads: false,
      firstNonEmptyTab: 'recent',
    });
    const cleared = sidebarTabReducer(membershipChanged, {
      type: 'filter-reconciled',
      filterKey: '',
      activeTabHasThreads: true,
      firstNonEmptyTab: 'recent',
    });

    expect(filtered.activeTab).toBe('system');
    expect(membershipChanged.activeTab).toBe('system');
    expect(cleared.activeTab).toBe('favorites');
  });

  it('waits to observe a filter key until asynchronously loaded results can be shown', () => {
    const initial = createSidebarTabState('pinned');
    const waiting = sidebarTabReducer(initial, {
      type: 'filter-reconciled',
      filterKey: '["late result",null]',
      activeTabHasThreads: false,
      firstNonEmptyTab: null,
    });
    const loaded = sidebarTabReducer(waiting, {
      type: 'filter-reconciled',
      filterKey: '["late result",null]',
      activeTabHasThreads: false,
      firstNonEmptyTab: 'system',
    });

    expect(waiting.observedFilterKey).toBe('');
    expect(loaded.activeTab).toBe('system');
    expect(loaded.observedFilterKey).toBe('["late result",null]');
  });

  it('lets a later user selection supersede pending results for the same filter key', () => {
    const filterKey = '["late result",null]';
    const waiting = sidebarTabReducer(createSidebarTabState('recent'), {
      type: 'filter-reconciled',
      filterKey,
      activeTabHasThreads: false,
      firstNonEmptyTab: null,
    });
    const selected = sidebarTabReducer(waiting, {
      type: 'user-selected-tab',
      tab: 'pinned',
      filterKey,
    });
    const loaded = sidebarTabReducer(selected, {
      type: 'filter-reconciled',
      filterKey,
      activeTabHasThreads: false,
      firstNonEmptyTab: 'system',
    });

    expect(selected.observedFilterKey).toBe(filterKey);
    expect(loaded.activeTab).toBe('pinned');
  });
});

describe('sidebar tab preference persistence', () => {
  it('round-trips a valid preference and rejects corrupted values', () => {
    const storage = memoryStorage();
    writePreferredSidebarTab('pinned', storage);

    expect(storage.value(SIDEBAR_TAB_STORAGE_KEY)).toBe('pinned');
    expect(readPreferredSidebarTab(storage)).toBe('pinned');
    expect(readPreferredSidebarTab(memoryStorage({ [SIDEBAR_TAB_STORAGE_KEY]: 'bogus' }))).toBe('recent');
  });
});
