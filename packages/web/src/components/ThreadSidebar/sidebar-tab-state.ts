import type { SidebarTabId } from './thread-utils';

export const SIDEBAR_TAB_STORAGE_KEY = 'cat-cafe:sidebar:active-tab';

const DEFAULT_TAB: SidebarTabId = 'recent';
const VALID_TABS = new Set<SidebarTabId>(['pinned', 'recent', 'project', 'system', 'favorites']);

interface SidebarTabStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

function accessStorage<T>(operation: () => T, unavailableValue: T): T {
  try {
    return operation();
  } catch {
    return unavailableValue;
  }
}

export interface SidebarTabState {
  activeTab: SidebarTabId;
  preferredTab: SidebarTabId;
  initialThreadResolved: boolean;
  observedFilterKey: string;
}

export interface SidebarTabPreference {
  tab: SidebarTabId;
  persisted: boolean;
}

export type SidebarTabEvent =
  | { type: 'user-selected-tab'; tab: SidebarTabId; filterKey: string }
  | {
      type: 'filter-reconciled';
      filterKey: string;
      activeTabHasThreads: boolean;
      firstNonEmptyTab: SidebarTabId | null;
    }
  | {
      type: 'initial-thread-reconciled';
      visibleInActiveTab: boolean;
      destinationTab: SidebarTabId | null;
    };

export function readSidebarTabPreference(storage?: SidebarTabStorage): SidebarTabPreference {
  if (!storage) return { tab: DEFAULT_TAB, persisted: false };
  return accessStorage(
    () => {
      const stored = storage.getItem(SIDEBAR_TAB_STORAGE_KEY);
      return stored && VALID_TABS.has(stored as SidebarTabId)
        ? { tab: stored as SidebarTabId, persisted: true }
        : { tab: DEFAULT_TAB, persisted: false };
    },
    { tab: DEFAULT_TAB, persisted: false },
  );
}

export function readPreferredSidebarTab(storage?: SidebarTabStorage): SidebarTabId {
  return readSidebarTabPreference(storage).tab;
}

export function readBrowserSidebarTabPreference(): SidebarTabPreference {
  if (typeof window === 'undefined') return { tab: DEFAULT_TAB, persisted: false };
  return accessStorage(() => readSidebarTabPreference(window.localStorage), { tab: DEFAULT_TAB, persisted: false });
}

export function writePreferredSidebarTab(tab: SidebarTabId, storage?: SidebarTabStorage): void {
  if (!storage) return;
  accessStorage(() => {
    storage.setItem(SIDEBAR_TAB_STORAGE_KEY, tab);
  }, undefined);
}

export function writeBrowserSidebarTabPreference(tab: SidebarTabId): void {
  if (typeof window === 'undefined') return;
  accessStorage(() => window.localStorage.setItem(SIDEBAR_TAB_STORAGE_KEY, tab), undefined);
}

export function createSidebarTabState(
  preferredTab: SidebarTabId = DEFAULT_TAB,
  initialThreadResolved = false,
): SidebarTabState {
  return {
    activeTab: preferredTab,
    preferredTab,
    initialThreadResolved,
    observedFilterKey: '',
  };
}

function reconcileFilter(
  state: SidebarTabState,
  event: Extract<SidebarTabEvent, { type: 'filter-reconciled' }>,
): SidebarTabState {
  if (state.observedFilterKey === event.filterKey) return state;
  if (event.filterKey.length === 0) {
    return { ...state, activeTab: state.preferredTab, observedFilterKey: '' };
  }
  if (!event.activeTabHasThreads && event.firstNonEmptyTab === null) return state;
  return {
    ...state,
    activeTab: tabAfterFilter(state, event),
    observedFilterKey: event.filterKey,
  };
}

function tabAfterFilter(
  state: SidebarTabState,
  event: Extract<SidebarTabEvent, { type: 'filter-reconciled' }>,
): SidebarTabId {
  if (event.activeTabHasThreads) return state.activeTab;
  return event.firstNonEmptyTab === null ? state.activeTab : event.firstNonEmptyTab;
}

function reconcileInitialThread(
  state: SidebarTabState,
  event: Extract<SidebarTabEvent, { type: 'initial-thread-reconciled' }>,
): SidebarTabState {
  if (state.initialThreadResolved) return state;
  return {
    ...state,
    activeTab: tabAfterInitialThread(state, event),
    initialThreadResolved: true,
  };
}

function tabAfterInitialThread(
  state: SidebarTabState,
  event: Extract<SidebarTabEvent, { type: 'initial-thread-reconciled' }>,
): SidebarTabId {
  if (event.visibleInActiveTab) return state.activeTab;
  return event.destinationTab === null ? state.activeTab : event.destinationTab;
}

export function sidebarTabReducer(state: SidebarTabState, event: SidebarTabEvent): SidebarTabState {
  if (event.type === 'user-selected-tab') {
    if (
      state.activeTab === event.tab &&
      state.preferredTab === event.tab &&
      state.initialThreadResolved &&
      state.observedFilterKey === event.filterKey
    )
      return state;
    return {
      ...state,
      activeTab: event.tab,
      preferredTab: event.tab,
      initialThreadResolved: true,
      observedFilterKey: event.filterKey,
    };
  }
  return event.type === 'filter-reconciled' ? reconcileFilter(state, event) : reconcileInitialThread(state, event);
}
