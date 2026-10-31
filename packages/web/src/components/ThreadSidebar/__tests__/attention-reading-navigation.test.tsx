import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { writeShellPresentation } from '../../shell/shell-presentation';
import type { AttentionRenderItem } from '../attention-clusters';
import { useAttentionListOrder } from '../use-attention-list-order';

it('v2 applies recent order at navigation boundaries and holds fresh facts within the reading session', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  writeShellPresentation('v2');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const row = (id: string, lastActiveAt: number) =>
    ({ id, lastActiveAt, pinned: false, presence: { status: 'done' } }) as SidebarSnapshotRow;
  const lists = (activity: number): Record<string, AttentionRenderItem[]> => ({
    flat: [
      {
        kind: 'cluster',
        cluster: {
          anchor: 'group:g',
          groupId: 'g',
          rootThreadId: 'a',
          title: 'Group',
          memberIds: ['a', 'b'],
          searchText: '',
        },
        members: [row('a', activity), row('b', 20)],
      },
      { kind: 'thread', thread: row('outside', 30) },
    ],
  });
  const isOpen = () => true;
  function Probe({ activity, scope }: { activity: number; scope: string }) {
    const ordered = useAttentionListOrder(lists(activity), isOpen, {}, scope, '', false).flat!;
    return <div>{ordered.map((item) => item.key).join(',')}</div>;
  }
  try {
    act(() => root.render(<Probe activity={10} scope="pinned" />));
    const reading = host.textContent;
    expect(reading?.indexOf('thread:outside')).toBeLessThan(reading!.indexOf('group:g'));
    act(() => root.render(<Probe activity={50} scope="pinned" />));
    expect(host.textContent).toBe(reading);
    act(() => writeShellPresentation('classic'));
    expect(host.textContent?.indexOf('group:g')).toBeLessThan(host.textContent!.indexOf('thread:outside'));
    expect(host.textContent?.indexOf(':a')).toBeLessThan(host.textContent!.indexOf(':b'));
    act(() => root.render(<Probe activity={10} scope="pinned" />));
    act(() => writeShellPresentation('v2'));
    expect(host.textContent).toBe(reading);
    act(() => root.render(<Probe activity={50} scope="pinned" />));
    expect(host.textContent).toBe(reading);
    act(() => root.render(<Probe activity={50} scope="recent" />));
    expect(host.textContent?.indexOf('group:g')).toBeLessThan(host.textContent!.indexOf('thread:outside'));
    expect(host.textContent?.indexOf(':a')).toBeLessThan(host.textContent!.indexOf(':b'));
  } finally {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    vi.unstubAllGlobals();
  }
});
