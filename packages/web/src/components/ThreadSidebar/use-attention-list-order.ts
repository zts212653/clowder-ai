import type { ThreadAttentionMemberSort } from '@cat-cafe/shared';
import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  type AttentionCluster,
  type AttentionListRow,
  type AttentionRenderItem,
  flattenAttentionRows,
} from './attention-clusters';
import { type AttentionOrderSnapshot, orderAttentionList } from './attention-list-order';

/** Shared by flat, project and virtual lists; virtualization cannot unmount the reading session. */
export function useAttentionListOrder(
  lists: Readonly<Record<string, AttentionRenderItem[]>>,
  isOpen: (cluster: AttentionCluster) => boolean,
  modes: Readonly<Record<string, ThreadAttentionMemberSort>>,
  scope: string,
  query: string,
  arranging: boolean,
): Record<string, AttentionListRow[]> {
  const committed = useRef<{ scope: string; snapshots: Record<string, AttentionOrderSnapshot> }>();
  const { snapshots, rows } = useMemo(() => {
    const previous = committed.current?.scope === scope ? committed.current.snapshots : {};
    const snapshots: Record<string, AttentionOrderSnapshot> = {};
    const rows: Record<string, AttentionListRow[]> = {};
    for (const [key, items] of Object.entries(lists)) {
      const result = orderAttentionList(items, isOpen, arranging ? {} : modes, arranging ? undefined : previous[key]);
      snapshots[key] = result.snapshot;
      rows[key] = flattenAttentionRows(result.items, isOpen, query);
    }
    return { snapshots, rows };
  }, [lists, isOpen, modes, scope, query, arranging]);
  // An abandoned concurrent render must not become a remembered user-visible order.
  useLayoutEffect(() => {
    committed.current = { scope, snapshots };
  }, [scope, snapshots]);
  return rows;
}
