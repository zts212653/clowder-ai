import type { ThreadAttentionGroup, ThreadAttentionMemberSort } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import {
  type ArrangeLayout,
  captureArrangeLayout,
  moveArrangeThread,
  projectArrangeLayout,
} from './attention-arrange-layout';
import type { AttentionCluster, AttentionListRow } from './attention-clusters';

export function useAttentionArrangeSession(
  rows: readonly SidebarSnapshotRow[],
  clusters: readonly AttentionCluster[],
  modes: Readonly<Record<string, ThreadAttentionMemberSort>>,
) {
  const [layout, setLayout] = useState<ArrangeLayout | null>(null);
  const finish = useCallback(() => setLayout(null), []);
  const begin = useCallback(
    (full: Record<string, AttentionListRow[]>, visible: Record<string, AttentionListRow[]>) =>
      setLayout((current) => current ?? captureArrangeLayout(full, visible)),
    [],
  );
  const reveal = useCallback(
    (anchor: string) =>
      setLayout(
        (current) =>
          current &&
          Object.fromEntries(
            Object.entries(current).map(([key, items]) => [
              key,
              items.map((item) =>
                item.kind === 'group' && item.anchor === anchor
                  ? { ...item, visibleCount: item.memberIds.length }
                  : item,
              ),
            ]),
          ),
      ),
    [],
  );
  const toggle = useCallback(
    (anchor: string) =>
      setLayout(
        (current) =>
          current &&
          Object.fromEntries(
            Object.entries(current).map(([key, items]) => [
              key,
              items.map((item) =>
                item.kind === 'group' && item.anchor === anchor
                  ? {
                      ...item,
                      expanded: !item.expanded,
                      visibleCount: item.visibleCount || Math.min(4, item.memberIds.length),
                    }
                  : item,
              ),
            ]),
          ),
      ),
    [],
  );
  const apply = useCallback(
    (sourceId: string, groups: readonly ThreadAttentionGroup[]) =>
      setLayout((current) => current && moveArrangeThread(current, sourceId, groups, modes, rows)),
    [modes, rows],
  );
  return {
    active: layout !== null,
    begin,
    finish,
    reveal,
    toggle,
    apply,
    project: (normal: Record<string, AttentionListRow[]>) =>
      layout ? projectArrangeLayout(layout, rows, clusters) : normal,
  };
}
