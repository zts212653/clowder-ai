import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Thread } from '@/stores/chat-types';
import { type SidebarSnapshotRow, useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import {
  createThreadSidebarHarness,
  installThreadSidebarGlobals,
  mockStore,
  resetThreadSidebarGlobals,
  resetThreadSidebarMocks,
  type ThreadSidebarHarness,
} from './thread-sidebar-test-helpers';

const NOW = 1_710_000_000_000;
const ROW_HEIGHT = 80;
const STICKY_HEIGHT = 40;
const VIEWPORT_HEIGHT = 240;
const originalCss = globalThis.CSS;

type TestThread = Thread & Partial<Pick<SidebarSnapshotRow, 'presence'>>;

function makePinnedThread(index: number, overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: `pinned-${index}`,
    projectPath: '/projects/cat-cafe',
    title: `Pinned ${index}`,
    createdBy: 'user',
    participants: [],
    lastActiveAt: NOW - index * 1_000,
    createdAt: NOW - index * 1_000,
    pinned: true,
    favorited: false,
    preferredCats: [],
    presence: { status: 'idle' },
    ...overrides,
  };
}

const rect = (top: number, height: number): DOMRect =>
  ({
    x: 0,
    y: top,
    top,
    right: 240,
    bottom: top + height,
    left: 0,
    width: 240,
    height,
    toJSON: () => ({}),
  }) as DOMRect;

function findScrollContainer(root: HTMLElement): HTMLDivElement {
  const scroller = Array.from(root.querySelectorAll('div')).find(
    (element): element is HTMLDivElement =>
      element.className.includes('overflow-y-auto') && element.querySelector('[data-thread-id]') !== null,
  );
  if (!scroller) throw new Error('sidebar scroll container not found');
  return scroller;
}

function installListGeometry(root: HTMLElement) {
  const scroller = findScrollContainer(root);
  Object.defineProperty(scroller, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true });

  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this === scroller) return rect(0, VIEWPORT_HEIGHT);
    if (this.dataset.scrollOccluder === 'true') return rect(0, STICKY_HEIGHT);
    if (this.dataset.threadId) {
      const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-thread-id]'));
      const index = rows.indexOf(this);
      return rect(STICKY_HEIGHT + index * ROW_HEIGHT - scroller.scrollTop, ROW_HEIGHT);
    }
    return rect(0, 0);
  });

  return {
    scroller,
    rowRect(threadId: string) {
      const row = scroller.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
      if (!row) throw new Error(`thread row ${threadId} not found`);
      return row.getBoundingClientRect();
    },
  };
}

function startWorking(threadId: string) {
  const state = useSidebarProjectionStore.getState();
  useSidebarProjectionStore.setState({
    rows: state.rows.map((row) =>
      row.id === threadId ? { ...row, presence: { status: 'working' as const, activeSince: NOW - 60_000 } } : row,
    ),
    appliedGeneration: state.appliedGeneration + 1,
  });
}

async function selectPinnedTab(harness: ThreadSidebarHarness) {
  const pinnedTab = harness.container.querySelector('[data-testid="sidebar-tab-pinned"]') as HTMLButtonElement;
  await act(async () => pinnedTab.click());
  await harness.flush();
}

describe('ThreadSidebar current working row visibility', () => {
  let harness: ThreadSidebarHarness;

  beforeEach(() => {
    installThreadSidebarGlobals();
    resetThreadSidebarMocks();
    window.sessionStorage.clear();
    Object.defineProperty(globalThis, 'CSS', {
      value: { escape: (value: string) => value },
      configurable: true,
    });
    harness = createThreadSidebarHarness();
  });

  afterEach(() => {
    harness.cleanup();
    resetThreadSidebarGlobals();
    vi.restoreAllMocks();
    window.sessionStorage.clear();
    Object.defineProperty(globalThis, 'CSS', { value: originalCss, configurable: true });
  });

  it('keeps the selected pinned row visible when idle becomes working and sorts to the front', async () => {
    const currentThreadId = 'pinned-5';
    Object.assign(mockStore, {
      currentThreadId,
      threads: Array.from({ length: 10 }, (_, index) => makePinnedThread(index)),
    });
    await harness.render();
    await selectPinnedTab(harness);

    expect(harness.container.querySelector('[data-testid="sidebar-tab-pinned"]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    const { scroller, rowRect } = installListGeometry(harness.container);
    scroller.scrollTop = 280;
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(rowRect(currentThreadId).top).toBeGreaterThanOrEqual(STICKY_HEIGHT);
    expect(rowRect(currentThreadId).bottom).toBeLessThanOrEqual(VIEWPORT_HEIGHT);

    act(() => startWorking(currentThreadId));
    await harness.flush();

    const firstRow = scroller.querySelector<HTMLElement>('[data-thread-id]');
    expect(firstRow?.dataset.threadId).toBe(currentThreadId);
    expect(rowRect(currentThreadId).top).toBeGreaterThanOrEqual(STICKY_HEIGHT);
    expect(rowRect(currentThreadId).bottom).toBeLessThanOrEqual(VIEWPORT_HEIGHT);
  });

  it('preserves the browsing anchor when a background pinned row starts working', async () => {
    const currentThreadId = 'pinned-8';
    Object.assign(mockStore, {
      currentThreadId,
      threads: Array.from({ length: 10 }, (_, index) => makePinnedThread(index)),
    });
    await harness.render();
    await selectPinnedTab(harness);

    const { scroller, rowRect } = installListGeometry(harness.container);
    scroller.scrollTop = 280;
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));
    const anchorId = 'pinned-3';
    const anchorTop = rowRect(anchorId).top;
    expect(rowRect(currentThreadId).top).toBeGreaterThan(VIEWPORT_HEIGHT);

    act(() => startWorking('pinned-7'));
    await harness.flush();

    expect(scroller.querySelector<HTMLElement>('[data-thread-id]')?.dataset.threadId).toBe('pinned-7');
    expect(rowRect(anchorId).top).toBe(anchorTop);
    expect(rowRect(currentThreadId).top).toBeGreaterThan(VIEWPORT_HEIGHT);
  });
});
