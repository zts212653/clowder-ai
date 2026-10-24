import React, { act, createRef, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import type { AttentionListRow } from '../attention-clusters';
import { useMeasuredSidebarRows } from '../use-measured-sidebar-rows';
import { useScrollAnchor } from '../use-scroll-anchor';
import { VirtualAttentionList } from '../VirtualAttentionList';
import type { VirtualThreadListHandle } from '../VirtualThreadList';

const threads: SidebarSnapshotRow[] = Array.from({ length: 260 }, (_, index) => ({
  id: `mixed-${index}`,
  title: index % 3 === 0 ? 'One line' : 'A wrapped title that occupies two lines',
  projectPath: '/project',
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
const snapshotRows = (): AttentionListRow[] =>
  threads.map((thread) => ({ kind: 'thread', key: `thread:${thread.id}`, thread: { ...thread } }));
const estimate = () => 52;
const handle = createRef<VirtualThreadListHandle>();

function Harness({ rows }: { rows: AttentionListRow[] }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { onScroll } = useScrollAnchor(scrollContainerRef, rows, { selectedThread: null });
  return (
    <div ref={scrollContainerRef} data-testid="scroller" onScroll={onScroll}>
      <div data-scroll-occluder="true">Sticky tabs</div>
      <VirtualAttentionList
        ref={handle}
        rows={rows}
        getRowHeight={estimate}
        scrollContainerRef={scrollContainerRef}
        renderItem={(row) => (
          <div data-thread-id={row.kind === 'thread' ? row.thread.id : ''}>
            {row.kind === 'thread' ? row.thread.title : row.key}
          </div>
        )}
      />
    </div>
  );
}

const rect = (top: number, height: number): DOMRect =>
  ({ x: 0, y: top, top, right: 240, bottom: top + height, left: 0, width: 240, height, toJSON: () => ({}) }) as DOMRect;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let positions: WeakMap<HTMLElement, number>;

beforeEach(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  positions = new WeakMap();
  sessionStorage.clear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'scroller' ? 240 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => 240);
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: HTMLElement) {
    let top = positions.get(this) ?? 0;
    if (this.dataset.testid === 'scroller') {
      // jsdom has no layout engine. Model the browser's native maximum clamp
      // against the actual production virtual list's declared total height.
      const height = Number.parseFloat(
        this.querySelector<HTMLElement>('[data-testid="virtual-attention-list"]')?.style.height ?? '0',
      );
      top = Math.min(top, Math.max(0, height - 240));
      positions.set(this, top);
    }
    return top;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: HTMLElement, top: number) {
    positions.set(this, Math.max(0, top));
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'scroller') return rect(0, 240);
    if (this.dataset.scrollOccluder) return rect(0, 40);
    if (this.dataset.threadId) {
      const scroller = this.closest<HTMLElement>('[data-testid="scroller"]');
      return rect(
        Number.parseFloat(this.parentElement?.style.top ?? '0') - (scroller?.scrollTop ?? 0),
        this.textContent === 'One line' ? 32 : 52,
      );
    }
    return rect(0, 0);
  });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

for (const location of ['middle', 'near-end'] as const) {
  it(`keeps the same visible mixed-height thread in place after unchanged snapshots ${location}`, () => {
    act(() => root.render(<Harness rows={snapshotRows()} />));
    const scroller = host.querySelector<HTMLElement>('[data-testid="scroller"]');
    if (!scroller) throw new Error('The production virtual list requires a scroll container');
    const scroll = () => scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    act(() => {
      scroller.scrollTop = location === 'middle' ? 700 : 99_999;
      scroll();
    });
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -237, bubbles: true }));
      scroller.scrollTop -= 237;
      scroll();
    });
    act(scroll);
    const anchor = [...scroller.querySelectorAll<HTMLElement>('[data-thread-id]')].find(
      (row) => row.getBoundingClientRect().bottom > 40,
    );
    if (!anchor) throw new Error('The scrolled production list must have a visible thread');
    const before = { top: scroller.scrollTop, y: anchor.getBoundingClientRect().top };
    const samples = [];
    for (let update = 0; update < 6; update++) {
      act(() => root.render(<Harness rows={snapshotRows()} />));
      const current = scroller.querySelector<HTMLElement>(`[data-thread-id="${anchor.dataset.threadId}"]`);
      samples.push({ top: scroller.scrollTop, y: current?.getBoundingClientRect().top });
      act(scroll);
    }
    for (const sample of samples) expect(sample.y).toBe(before.y);
  });
}

it('remeasures changed mounted content even when its canonical height estimate is unchanged', () => {
  act(() => root.render(<Harness rows={snapshotRows()} />));
  const first = () => host.querySelector<HTMLElement>('[data-thread-id="mixed-0"]');
  const nextTop = () => host.querySelector<HTMLElement>('[data-thread-id="mixed-1"]')?.parentElement?.style.top;
  expect(nextTop()).toBe('32px');
  const changed = snapshotRows().map((row) =>
    row.kind === 'thread' && row.thread.id === 'mixed-0'
      ? { ...row, thread: { ...row.thread, title: 'New canonical title wrapping onto two lines' } }
      : row,
  );
  act(() => root.render(<Harness rows={changed} />));
  expect(first()?.textContent).toBe('New canonical title wrapping onto two lines');
  expect(nextTop()).toBe('52px');
});

function MeasurementCacheHarness({ rows, start }: { rows: AttentionListRow[]; start: number }) {
  const container = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const measured = useMeasuredSidebarRows(rows, list, container, estimate, { start, end: start + 2 });
  return (
    <div ref={container} data-testid="scroller">
      <output data-testid="measured-keys">{[...measured.keys()].join(',')}</output>
      <div ref={list}>
        {rows.slice(start, start + 2).map((row) => (
          <div key={row.key} data-virtual-row-key={row.key}>
            <div data-thread-id={row.kind === 'thread' ? row.thread.id : ''}>
              {row.kind === 'thread' ? row.thread.title : row.key}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

it('retires deleted offscreen measurement keys while the mounted rows keep the same height', () => {
  const rows = snapshotRows().slice(0, 3);
  const keys = () => host.querySelector('[data-testid="measured-keys"]')?.textContent;
  act(() => root.render(<MeasurementCacheHarness rows={rows} start={0} />));
  act(() => root.render(<MeasurementCacheHarness rows={rows} start={1} />));
  expect(keys()).toContain('thread:mixed-0');
  act(() => root.render(<MeasurementCacheHarness rows={rows.slice(1)} start={0} />));
  expect(keys()).not.toContain('thread:mixed-0');
  expect(keys()).toContain('thread:mixed-1');
  expect(keys()).toContain('thread:mixed-2');
});
