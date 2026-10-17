import React, { act, createRef, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { VirtualThreadList, type VirtualThreadListHandle } from '../VirtualThreadList';

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

function Harness({ handleRef }: { handleRef: React.RefObject<VirtualThreadListHandle> }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollContainerRef} data-testid="scroller">
      <div data-scroll-occluder="true">Tabs</div>
      <VirtualThreadList
        ref={handleRef}
        threads={threads}
        scrollContainerRef={scrollContainerRef}
        renderItem={(thread) => <div data-thread-id={thread.id}>{thread.title}</div>}
      />
    </div>
  );
}

describe('VirtualThreadList nearest visibility', () => {
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
    writeShellPresentation('classic');
  });

  it('measures compact and multiline v2 rows and uses their real offsets for navigation', () => {
    writeShellPresentation('v2');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return rect(0, this.dataset.virtualRowKey ? (this.dataset.virtualRowKey === 'thread-0' ? 90 : 44) : 0);
    });
    const handleRef = createRef<VirtualThreadListHandle>();
    act(() => root.render(<Harness handleRef={handleRef} />));
    const list = host.querySelector('[data-testid="virtual-thread-list"]') as HTMLElement;
    const entries = [...list.querySelectorAll<HTMLElement>('[data-virtual-row-key]')];
    expect(entries[1].style.top).toBe('90px');
    expect(entries[2].style.top).toBe('134px');
    expect(entries[0].style.height).toBe('');
    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 100, configurable: true });
    Object.defineProperty(list, 'offsetParent', { value: scroller, configurable: true });
    act(() => handleRef.current?.ensureIndexVisible(2));
    expect(scroller.scrollTop).toBe(78);
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([
    'ensureIndexVisible',
    'scrollToIndex',
  ] as const)('keeps an unmeasured distant row visible after %s', (method) => {
    writeShellPresentation('v2');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = Number(this.dataset.virtualRowKey?.replace('thread-', ''));
      return rect(0, this.dataset.virtualRowKey ? (index % 3 === 0 ? 110 : 86) : 0);
    });
    const handleRef = createRef<VirtualThreadListHandle>();
    act(() => root.render(<Harness handleRef={handleRef} />));
    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLElement;
    const list = host.querySelector('[data-testid="virtual-thread-list"]') as HTMLElement;
    Object.defineProperty(scroller, 'clientHeight', { value: 240, configurable: true });
    Object.defineProperty(list, 'offsetParent', { value: scroller, configurable: true });
    act(() => handleRef.current?.[method](50));
    const target = list.querySelector<HTMLElement>('[data-virtual-row-key="thread-50"]');
    expect(target).not.toBeNull();
    const top = Number.parseFloat(target?.style.top ?? 'NaN');
    expect(top).toBeGreaterThanOrEqual(scroller.scrollTop);
    expect(top + 86).toBeLessThanOrEqual(scroller.scrollTop + 240);
  });

  it('moves only to the nearest edge and respects the sticky top inset', () => {
    const handleRef = createRef<VirtualThreadListHandle>();
    act(() => root.render(<Harness handleRef={handleRef} />));

    const scroller = host.querySelector('[data-testid="scroller"]') as HTMLDivElement;
    const list = host.querySelector('[data-testid="virtual-thread-list"]') as HTMLDivElement;
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
});
