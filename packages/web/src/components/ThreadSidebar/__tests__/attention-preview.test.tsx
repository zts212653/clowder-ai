import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { flattenAttentionRows } from '../attention-clusters';
import { useAttentionPreview } from '../use-attention-preview';

const members = Array.from(
  { length: 11 },
  (_, i) => ({ id: `member-${i}`, title: `Member ${i}` }) as SidebarSnapshotRow,
);
const cluster = {
  anchor: 'group:g',
  groupId: 'g',
  rootThreadId: 'member-0',
  title: 'Group',
  memberIds: members.map((m) => m.id),
  searchText: '',
};
const items = [{ kind: 'cluster' as const, cluster, members }];
const open = { flat: flattenAttentionRows(items, () => true, '') };
const closed = { flat: flattenAttentionRows(items, () => false, '') };
function Harness({
  expanded = true,
  currentId = 'other',
  enabled = true,
}: {
  expanded?: boolean;
  currentId?: string;
  enabled?: boolean;
}) {
  const { lists, reveal } = useAttentionPreview(expanded ? open : closed, currentId, enabled);
  return (
    <>
      {lists.flat?.map((row) =>
        row.kind === 'cluster-remainder' ? (
          <button type="button" key={row.key} onClick={() => reveal(row.cluster.anchor)}>
            {row.remainingCount}
          </button>
        ) : row.kind === 'cluster-member' ? (
          <span key={row.key} data-member={row.member.id}>
            {row.member.title}
          </span>
        ) : null,
      )}
    </>
  );
}

describe('F322 v2 group preview is presentation, never a membership cap', () => {
  let host: HTMLDivElement, root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const ids = () => [...host.querySelectorAll('[data-member]')].map((el) => el.getAttribute('data-member'));
  it('shows four and a truthful remainder that reveals every member in its existing order', () => {
    act(() => root.render(<Harness />));
    expect(ids()).toEqual(members.slice(0, 4).map((m) => m.id));
    expect(host.querySelector('button')?.textContent).toBe('7');
    act(() => host.querySelector('button')?.click());
    expect(ids()).toEqual(members.map((m) => m.id));
    expect(host.querySelector('button')).toBeNull();
    act(() => root.render(<Harness expanded={false} />));
    act(() => root.render(<Harness />));
    expect(ids()).toHaveLength(4);
  });
  it('keeps the preview when the selected conversation is already one of its four rows', () => {
    act(() => root.render(<Harness currentId="member-1" />));
    expect(ids()).toHaveLength(4);
    expect(host.querySelector('button')?.textContent).toBe('7');
  });
  it('keeps the current conversation reachable beyond the preview and never changes classic/search/arrange rows', () => {
    act(() => root.render(<Harness currentId="member-9" />));
    expect(ids()).toEqual(members.map((m) => m.id));
    expect(host.querySelector('button')).toBeNull();
    act(() => root.render(<Harness enabled={false} />));
    expect(ids()).toEqual(members.map((m) => m.id));
  });
});
