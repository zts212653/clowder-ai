'use client';

import type { ThreadAttentionGroup } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { AttentionArrangeToolbar } from '@/components/ThreadSidebar/AttentionArrangeToolbar';
import type { AttentionCluster, AttentionRenderItem } from '@/components/ThreadSidebar/attention-clusters';
import { ConversationGroupOrganizerDialog } from '@/components/ThreadSidebar/ConversationGroupOrganizerDialog';
import type { ThreadAttentionGroupCommand } from '@/components/ThreadSidebar/use-attention-clusters';
import type { SidebarSnapshotRow } from '@/stores/sidebarProjectionStore';
import { F277ClusterShell } from './cluster-shell';
import type { F277PreviewThread } from './fixtures';
import type { PreviewGroupState } from './preview-group-state';

interface PreviewAttentionListProps {
  items: readonly AttentionRenderItem[];
  query: string;
  openPreferences: Readonly<Record<string, boolean>>;
  activeClusterAnchor?: string;
  arrangeMode: boolean;
  draggedThreadId: string | null;
  clusterByThreadId: ReadonlyMap<string, AttentionCluster>;
  organizerThread?: F277PreviewThread;
  threads: readonly F277PreviewThread[];
  groupState: PreviewGroupState;
  viewIdForCluster: (cluster: AttentionCluster) => string;
  titleForCluster: (cluster: AttentionCluster) => string;
  renderThread: (thread: SidebarSnapshotRow) => ReactNode;
  onToggleCluster: (viewId: string, expanded: boolean) => void;
  onRenameCluster: (cluster: AttentionCluster, alias: string | null) => void;
  onDropCluster: (sourceThreadId: string, cluster: AttentionCluster) => void;
  onMutateGroup: (command: ThreadAttentionGroupCommand) => void;
  onSetArrangeMode: (arranging: boolean) => void;
  onSetDraggedThreadId: (threadId: string | null) => void;
  onCloseOrganizer: () => void;
}

export function PreviewAttentionList({
  items,
  query,
  openPreferences,
  activeClusterAnchor,
  arrangeMode,
  draggedThreadId,
  clusterByThreadId,
  organizerThread,
  threads,
  groupState,
  viewIdForCluster,
  titleForCluster,
  renderThread,
  onToggleCluster,
  onRenameCluster,
  onDropCluster,
  onMutateGroup,
  onSetArrangeMode,
  onSetDraggedThreadId,
  onCloseOrganizer,
}: PreviewAttentionListProps) {
  const previewThreadById = new Map(threads.map((thread) => [thread.id, thread]));
  return (
    <>
      <section className="flex-1 space-y-2 overflow-y-auto py-3" aria-label="注意力分组">
        {arrangeMode && (
          <AttentionArrangeToolbar
            draggedThreadId={draggedThreadId}
            canRemoveDragged={Boolean(draggedThreadId && clusterByThreadId.get(draggedThreadId)?.groupId)}
            onRemoveDragged={(threadId) => {
              const groupId = clusterByThreadId.get(threadId)?.groupId;
              if (groupId) onMutateGroup({ action: 'remove', groupId, threadId });
              onSetDraggedThreadId(null);
            }}
            onDone={() => {
              onSetArrangeMode(false);
              onSetDraggedThreadId(null);
            }}
          />
        )}
        {items.map((item) => {
          if (item.kind === 'thread') return <div key={item.thread.id}>{renderThread(item.thread)}</div>;
          const cluster = item.cluster;
          const viewId = viewIdForCluster(cluster);
          const members = item.members
            .map((member) => previewThreadById.get(member.id))
            .filter((member): member is F277PreviewThread => member !== undefined);
          const expanded = query.trim()
            ? true
            : Object.hasOwn(openPreferences, viewId)
              ? openPreferences[viewId]
              : activeClusterAnchor === cluster.anchor;
          return (
            <F277ClusterShell
              key={cluster.anchor}
              cluster={cluster}
              members={members}
              dataClusterId={viewId}
              displayTitle={titleForCluster(cluster)}
              expanded={expanded}
              query={query}
              draggedThreadId={draggedThreadId}
              onToggle={() => onToggleCluster(viewId, expanded)}
              onRename={(alias) => onRenameCluster(cluster, alias)}
              onDropCluster={onDropCluster}
              onDragEndThread={() => onSetDraggedThreadId(null)}
              renderThread={(thread) => renderThread(thread)}
            />
          );
        })}
        {items.length === 0 && <p className="px-5 py-8 text-center text-sm text-cafe-muted">没有匹配的对话</p>}
      </section>
      {organizerThread && (
        <ConversationGroupOrganizerDialog
          thread={organizerThread}
          threads={threads}
          groups={groupState.groups as readonly ThreadAttentionGroup[]}
          onCommand={onMutateGroup}
          onClose={onCloseOrganizer}
        />
      )}
    </>
  );
}
