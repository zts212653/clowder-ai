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
import type { ArrangeSignalSlot } from './ThreadRowSignals';

export function useAttentionArrangeSession(
  rows: readonly SidebarSnapshotRow[],
  clusters: readonly AttentionCluster[],
  modes: Readonly<Record<string, ThreadAttentionMemberSort>>,
  decisions: ReadonlySet<string>,
  plainView = false,
) {
  const [layout, setLayout] = useState<ArrangeLayout | null>(null);
  const [signalSlots, setSignalSlots] = useState<Record<string, ArrangeSignalSlot>>({});
  const finish = useCallback(() => {
    setLayout(null);
    setSignalSlots({});
  }, []);
  const begin = useCallback(
    (
      full: Record<string, AttentionListRow[]>,
      visible: Record<string, AttentionListRow[]>,
      signals: Record<string, ArrangeSignalSlot>,
      decisions: ReadonlySet<string>,
      headerHeights: Record<string, Record<string, number>>,
    ) => {
      setLayout((current) => current ?? captureArrangeLayout(full, visible, decisions, headerHeights));
      setSignalSlots(signals);
    },
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
      // Plain tabs still persist membership commands, without introducing Group presentation.
      setLayout((current) =>
        !current || plainView ? current : moveArrangeThread(current, sourceId, groups, modes, rows, decisions),
      ),
    [modes, rows, decisions, plainView],
  );
  return {
    active: layout !== null,
    begin,
    finish,
    reveal,
    toggle,
    apply,
    signalSlots,
    project: (normal: Record<string, AttentionListRow[]>) =>
      layout ? projectArrangeLayout(layout, rows, clusters) : normal,
  };
}
