import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { writeShellPresentation } from '../../shell/shell-presentation';
import { arrangeAttentionRows, buildAttentionClusters } from '../attention-clusters';
import { useAttentionListOrder, useSidebarReadingSession } from '../use-attention-list-order';

it('holds row placement under the pointer, projects fresh facts, and recomputes recent members after leaving', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('v2');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Probe({ activity, group = true }: { activity: number; group?: boolean }) {
    const surface = useRef<HTMLDivElement>(null);
    const rows = [
      { id: 'a', pinned: false, lastActiveAt: activity, unreadCount: activity, presence: { status: 'done' } },
      { id: 'b', pinned: false, lastActiveAt: 20, unreadCount: 0, presence: { status: 'idle' } },
      { id: 'outside', pinned: false, lastActiveAt: 30, unreadCount: 10, presence: { status: 'idle' } },
    ] as SidebarSnapshotRow[];
    const groups = group ? [{ id: 'g', threadIds: ['a', 'b'] }] : [];
    const lists = { flat: arrangeAttentionRows(rows, rows, buildAttentionClusters(rows, groups), 'recent') };
    const scope = group ? 'group' : 'plain';
    const reading = useSidebarReadingSession(surface, true, scope);
    const ordered = useAttentionListOrder(lists, () => true, {}, scope, '', false, reading.held).flat!;
    return (
      <div ref={surface} data-surface>
        {ordered.map((row) => (
          <div key={row.key} data-order={row.key}>
            {row.kind === 'cluster-member' ? row.member.unreadCount : ''}
          </div>
        ))}
      </div>
    );
  }
  const order = () => [...host.querySelectorAll('[data-order]')].map((element) => element.getAttribute('data-order'));
  const point = (type: string) => act(() => host.querySelector('[data-surface]')?.dispatchEvent(new Event(type)));
  try {
    act(() => root.render(<Probe activity={10} />));
    const original = order();
    expect(original).toEqual([
      'thread:outside',
      'cluster:group:g',
      'cluster-member:group:g:b',
      'cluster-member:group:g:a',
    ]);
    point('pointerenter');
    act(() => root.render(<Probe activity={50} />));
    expect(order()).toEqual(original);
    expect(host.querySelector('[data-order="cluster-member:group:g:a"]')?.textContent).toBe('50');
    point('pointerleave');
    expect(order()).toEqual([
      'cluster:group:g',
      'cluster-member:group:g:a',
      'cluster-member:group:g:b',
      'thread:outside',
    ]);
    // A recent list without any Groups must follow the same rule and protect its click targets too.
    act(() => root.render(<Probe activity={10} group={false} />));
    const plain = order();
    point('pointerenter');
    act(() => root.render(<Probe activity={50} group={false} />));
    expect(order()).toEqual(plain);
    point('pointerleave');
    expect(order()).toEqual(['thread:a', 'thread:outside', 'thread:b']);
    act(() => writeShellPresentation('classic'));
    const classic = order();
    point('pointerenter');
    act(() => root.render(<Probe activity={10} group={false} />));
    point('pointerleave');
    expect(order()).toEqual(classic);
  } finally {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    vi.unstubAllGlobals();
  }
});

it('compacts read content within the list while retaining the pointer ordering session', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const natural = Number(this.dataset.height ?? this.firstElementChild?.getAttribute('data-height') ?? 0);
    const height = Math.max(natural, Number.parseFloat(this.style.minHeight) || 0);
    return { top: 0, bottom: height, height, left: 0, right: 240, width: 240, x: 0, y: 0, toJSON: () => ({}) };
  });
  function Probe({ height }: { height: number }) {
    const surface = useRef<HTMLDivElement>(null);
    const reading = useSidebarReadingSession(surface, true, 'same-list');
    return (
      <div ref={surface} data-surface data-held={reading.held}>
        <div data-sidebar-row-key="read-row" style={{ minHeight: reading.heights['read-row'] }}>
          <div data-height={height}>{height === 120 ? 'Unread preview' : 'Current facts'}</div>
        </div>
      </div>
    );
  }
  try {
    await act(async () => root.render(<Probe height={120} />));
    act(() => host.querySelector('[data-surface]')?.dispatchEvent(new Event('pointerenter')));
    act(() =>
      host.querySelector('[data-sidebar-row-key]')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })),
    );
    await act(async () => root.render(<Probe height={40} />));
    const wrapper = host.querySelector<HTMLElement>('[data-sidebar-row-key]');
    expect(wrapper?.getBoundingClientRect().height).toBe(120); // Preserve the immediate next-click target.
    await act(async () => vi.advanceTimersByTimeAsync(250));
    act(() => host.querySelector('[data-surface]')?.dispatchEvent(new MouseEvent('pointermove', { bubbles: true })));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(wrapper?.getBoundingClientRect().height).toBe(40); // Do not keep the empty slot until pointerleave.
    expect(host.querySelector('[data-surface]')?.getAttribute('data-held')).toBe('true');
  } finally {
    act(() => root.unmount());
    host.remove();
    bounds.mockRestore();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
