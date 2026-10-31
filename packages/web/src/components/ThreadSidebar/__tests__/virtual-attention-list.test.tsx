import React, { act, createRef, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import type { AttentionListRow } from '../attention-clusters';
import { VirtualAttentionList } from '../VirtualAttentionList';
import type { VirtualThreadListHandle } from '../VirtualThreadList';

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

const threads: SidebarSnapshotRow[] = Array.from({ length: 100 }, (_, index) => ({
  id: `thread-${index}`,
  title: `Thread ${index}`,
  projectPath: '/projects/cat-cafe',
  createdBy: 'user',
  participants: [],
  lastActiveAt: index,
  createdAt: index,
  pinned: true,
  favorited: false,
  preferredCats: [],
  unreadCount: 0,
  hasUserMention: false,
  labels: [],
  systemKind: null,
  isHubThread: false,
  presence: { status: 'idle' },
}));

const rows: AttentionListRow[] = threads.map((thread) => ({
  kind: 'thread',
  key: `thread:${thread.id}`,
  thread,
}));

function Harness({
  handleRef,
  getRowHeight,
}: {
  handleRef: React.RefObject<VirtualThreadListHandle>;
  getRowHeight?: (row: AttentionListRow) => number;
}) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollContainerRef} data-testid="scroller">
      <div data-scroll-occluder="true">Tabs</div>
      <VirtualAttentionList
        ref={handleRef}
        rows={rows}
        getRowHeight={getRowHeight}
        scrollContainerRef={scrollContainerRef}
        renderItem={(row) => <div data-row-key={row.key}>{row.key}</div>}
      />
    </div>
  );
}

describe('VirtualAttentionList nearest visibility', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('keeps the selected attention row visible around the sticky tab occluder', () => {
    const handleRef = createRef<VirtualThreadListHandle>();
    act(() => root.render(<Harness handleRef={handleRef} />));

    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    const list = host.querySelector('[data-testid="virtual-attention-list"]') as HTMLDivElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 240, configurable: true });
    Object.defineProperty(list, 'offsetTop', { value: 80, configurable: true });
    Object.defineProperty(list, 'offsetParent', { value: scroller, configurable: true });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === scroller) return rect(0, 240);
      if (this.dataset.scrollOccluder === 'true') return rect(0, 40);
      return rect(0, 0);
    });

    scroller.scrollTop = 2_400;
    act(() => handleRef.current?.ensureIndexVisible(33));
    expect(scroller.scrollTop).toBe(2_560);

    act(() => handleRef.current?.ensureIndexVisible(0));
    expect(scroller.scrollTop).toBe(40);
  });
  it('measures wrapped content, repositions following rows and remeasures when the sidebar narrows', () => {
    const observers: ResizeObserverCallback[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
    let firstHeight = 96;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(0, this.dataset.rowKey === 'thread:thread-0' ? firstHeight : 0);
    });
    const handleRef = createRef<VirtualThreadListHandle>();
    const getRowHeight = () => 72;
    act(() => root.render(<Harness handleRef={handleRef} getRowHeight={getRowHeight} />));
    const list = host.querySelector('[data-testid="virtual-attention-list"]') as HTMLDivElement;
    expect(list.style.height).toBe('7224px');
    expect(host.querySelector('[data-row-key="thread:thread-1"]')?.parentElement?.style.top).toBe('96px');
    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    scroller.scrollTop = 240;
    firstHeight = 144;
    act(() => {
      for (const observer of [...observers]) observer([], {} as ResizeObserver);
    });
    expect(host.querySelector('[data-row-key="thread:thread-1"]')?.parentElement?.style.top).toBe('144px');
    expect(list.style.height).toBe('7272px');
    expect(scroller.scrollTop).toBe(288);
    vi.unstubAllGlobals();
  });
  it('releases the measured virtual slot when the same row leaves its reading-height hold', () => {
    let contentHeight = 120;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(0, this.dataset.rowKey === 'thread:thread-0' ? contentHeight : 0);
    });
    const handleRef = createRef<VirtualThreadListHandle>();
    act(() => root.render(<Harness handleRef={handleRef} getRowHeight={(row) => (row === rows[0] ? 120 : 72)} />));
    const next = () => host.querySelector('[data-row-key="thread:thread-1"]')?.parentElement?.style.top;
    expect(next()).toBe('120px');
    contentHeight = 40;
    act(() => root.render(<Harness handleRef={handleRef} getRowHeight={(row) => (row === rows[0] ? 40 : 72)} />));
    expect(next()).toBe('40px');
    expect(host.querySelector<HTMLElement>('[data-testid="virtual-attention-list"]')?.style.height).toBe('7168px');
  });
  it('positions and locates compact rows with mixed one-line and two-line heights', () => {
    const handleRef = createRef<VirtualThreadListHandle>();
    const getRowHeight = (row: AttentionListRow) => (row.key === 'thread:thread-0' ? 32 : 52);
    act(() => root.render(<Harness handleRef={handleRef} getRowHeight={getRowHeight} />));
    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    const list = host.querySelector('[data-testid="virtual-attention-list"]') as HTMLDivElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 240, configurable: true });
    expect(list.style.height).toBe('5180px');
    expect(host.querySelector('[data-row-key="thread:thread-1"]')?.parentElement?.style.top).toBe('32px');
    act(() => handleRef.current?.ensureIndexVisible(20));
    expect(scroller.scrollTop).toBe(832);
    expect(host.querySelector('[data-row-key="thread:thread-20"]')).not.toBeNull();
    act(() => handleRef.current?.scrollToIndex(50));
    expect(scroller.scrollTop).toBe(2486);
    expect(host.querySelector('[data-row-key="thread:thread-50"]')).not.toBeNull();
  });
  it('invalidates offscreen measurement cache when pending decisions change', () => {
    const handleRef = createRef<VirtualThreadListHandle>();
    let decisions = new Set<string>();

    // Mock getBoundingClientRect to return real heights matching getRowHeight
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const key = this.dataset.rowKey;
      if (!key) return rect(0, 0);
      const threadId = key.split(':')[1];
      const height = decisions.has(threadId) ? 76 : 52;
      return rect(0, height);
    });

    // Test control ref with explicit type
    const updateDecisionsRef = { current: null as ((newDecisions: Set<string>) => void) | null };

    function DynamicHarness() {
      const scrollContainerRef = useRef<HTMLDivElement>(null);
      const [groupDecisions, setGroupDecisions] = React.useState<{ status: 'ready'; threadIds: Set<string> }>({
        status: 'ready',
        threadIds: decisions,
      });
      // Home ties measured cache entries to the canonical height estimate. Keep that
      // estimate reactive to decision changes, as ThreadSidebar's callback does.
      const getRowHeight = React.useCallback(
        (row: AttentionListRow) => {
          const threadId = row.kind === 'thread' ? row.thread.id : '';
          return groupDecisions.threadIds.has(threadId) ? 76 : 52;
        },
        [groupDecisions],
      );
      // Expose setter for test control via typed ref
      updateDecisionsRef.current = (newDecisions: Set<string>) => {
        decisions = newDecisions;
        setGroupDecisions({ status: 'ready', threadIds: newDecisions });
      };
      return (
        <div ref={scrollContainerRef} data-testid="scroller">
          <div data-scroll-occluder="true">Tabs</div>
          <VirtualAttentionList
            ref={handleRef}
            rows={rows}
            getRowHeight={getRowHeight}
            scrollContainerRef={scrollContainerRef}
            renderItem={(row) => <div data-row-key={row.key}>{row.key}</div>}
          />
        </div>
      );
    }

    act(() => root.render(<DynamicHarness />));
    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    const list = host.querySelector('[data-testid="virtual-attention-list"]') as HTMLDivElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 640, configurable: true });

    // Initial: all 52px, total = 52 * 100 = 5200px
    expect(list.style.height).toBe('5200px');

    // Scroll to make row 50 visible and measure it (enters cache with 52px)
    act(() => handleRef.current?.scrollToIndex(50));
    expect(host.querySelector('[data-row-key="thread:thread-50"]')).not.toBeNull();

    // Scroll row 50 offscreen (back to top)
    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(host.querySelector('[data-row-key="thread:thread-50"]')).toBeNull();

    // Add decision for thread-50 (should invalidate cache)
    act(() => {
      updateDecisionsRef.current?.(new Set(['thread-50']));
    });

    // Total should update immediately: 52*99 + 76 = 5224px
    // Cache invalidation ensures offscreen row uses new height, not stale 52px
    expect(list.style.height).toBe('5224px');

    // Scroll thread-50 offscreen again before removing decision
    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(host.querySelector('[data-row-key="thread:thread-50"]')).toBeNull();

    // Remove decision (thread-50 still offscreen)
    act(() => {
      updateDecisionsRef.current?.(new Set());
    });

    // Total should return to 5200px immediately (cache invalidated again)
    expect(list.style.height).toBe('5200px');
  });
});
