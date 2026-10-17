import { forwardRef, type ReactNode, type RefObject } from 'react';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { useShellPresentation } from '../shell/shell-presentation';
import { VirtualSidebarList } from './VirtualSidebarList';
export const VIRTUAL_THREAD_LIST_THRESHOLD = 50;
export interface VirtualThreadListHandle {
  scrollToIndex(index: number): void;
  ensureIndexVisible(index: number): void;
}
interface VirtualThreadListProps {
  threads: SidebarSnapshotRow[];
  scrollContainerRef: RefObject<HTMLDivElement>;
  renderItem: (thread: SidebarSnapshotRow) => ReactNode;
}
const itemKey = (item: SidebarSnapshotRow) => item.id;
export const VirtualThreadList = forwardRef<VirtualThreadListHandle, VirtualThreadListProps>(function VirtualThreadList(
  { threads, scrollContainerRef, renderItem },
  ref,
) {
  const measured = useShellPresentation() === 'v2';
  return (
    <VirtualSidebarList
      items={threads}
      itemKey={itemKey}
      renderItem={renderItem}
      scrollContainerRef={scrollContainerRef}
      handleRef={ref}
      measured={measured}
      testId="virtual-thread-list"
    />
  );
});
