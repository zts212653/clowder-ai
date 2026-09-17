'use client';

import type { ReactNode } from 'react';
import { AttentionClusterHeader, AttentionClusterMember } from '@/components/ThreadSidebar/AttentionCluster';
import type { AttentionCluster } from '@/components/ThreadSidebar/attention-clusters';
import type { F277PreviewThread } from './fixtures';

interface F277ClusterShellProps {
  cluster: AttentionCluster;
  members: readonly F277PreviewThread[];
  dataClusterId: string;
  displayTitle: string;
  expanded: boolean;
  query: string;
  draggedThreadId: string | null;
  onToggle: () => void;
  onRename: (alias: string | null) => void;
  onDropCluster: (sourceThreadId: string, cluster: AttentionCluster) => void;
  onDragEndThread: () => void;
  renderThread: (thread: F277PreviewThread) => ReactNode;
}

function memberMatches(member: F277PreviewThread, query: string): boolean {
  return `${member.title ?? ''} ${member.id}`.toLocaleLowerCase().includes(query);
}

export function F277ClusterShell({
  cluster,
  members,
  dataClusterId,
  displayTitle,
  expanded,
  query,
  draggedThreadId,
  onToggle,
  onRename,
  onDropCluster,
  onDragEndThread,
  renderThread,
}: F277ClusterShellProps) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const clusterMatches = `${cluster.title} ${displayTitle}`.toLocaleLowerCase().includes(normalizedQuery);
  const visibleMembers =
    normalizedQuery && !clusterMatches ? members.filter((member) => memberMatches(member, normalizedQuery)) : members;

  return (
    <div data-cluster-id={dataClusterId} data-expanded={expanded}>
      <div
        role="group"
        aria-label={`对话组：${displayTitle}`}
        data-attention-drop-group={cluster.anchor}
        onDragOver={(event) => {
          if (!draggedThreadId || cluster.memberIds.includes(draggedThreadId)) return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        }}
        onDrop={(event) => {
          event.preventDefault();
          const sourceThreadId = draggedThreadId || event.dataTransfer?.getData('text/plain') || null;
          if (sourceThreadId) onDropCluster(sourceThreadId, cluster);
          onDragEndThread();
        }}
      >
        <AttentionClusterHeader
          cluster={cluster}
          members={members}
          expanded={expanded}
          displayTitle={displayTitle}
          onToggle={onToggle}
          onRename={onRename}
        />
      </div>

      {expanded &&
        visibleMembers.map((member, index) => (
          <AttentionClusterMember
            key={member.id}
            cluster={cluster}
            member={member}
            isFirst={index === 0}
            isLast={index === visibleMembers.length - 1}
            renderThread={() => renderThread(member)}
          />
        ))}
    </div>
  );
}
