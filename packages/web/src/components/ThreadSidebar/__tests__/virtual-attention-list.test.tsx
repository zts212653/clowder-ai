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

function Harness({ handleRef }: { handleRef: React.RefObject<VirtualThreadListHandle> }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollContainerRef} data-testid="scroller">
      <div data-scroll-occluder="true">Tabs</div>
      <VirtualAttentionList
        ref={handleRef}
        rows={rows}
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
});
