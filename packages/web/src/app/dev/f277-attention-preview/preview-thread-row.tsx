'use client';

import { AttentionGroupableThreadRow } from '@/components/ThreadSidebar/AttentionGroupableThreadRow';
import { ThreadItem } from '@/components/ThreadSidebar/ThreadItem';
import type { F277PreviewThread } from './fixtures';

interface PreviewThreadRowProps {
  thread: F277PreviewThread;
  activeThreadId: string;
  arrangeMode: boolean;
  draggedThreadId: string | null;
  onSelect: (threadId: string) => void;
  onDelete: (threadId: string) => void;
  onRename: (threadId: string, title: string) => void;
  onTogglePin: (threadId: string, pinned: boolean) => void;
  onToggleFavorite: (threadId: string, favorited: boolean) => void;
  onUpdatePreferredCats: (threadId: string, cats: string[]) => void;
  onUpdateLabels: (threadId: string, labels: string[]) => void;
  onOrganize: (threadId: string) => void;
  onReplay: (threadId: string) => void;
  onEnterArrange: () => void;
  onDragStartThread: (threadId: string) => void;
  onDragEndThread: () => void;
  getDraggedThreadId: () => string | null;
  onDropThread: (sourceThreadId: string, targetThreadId: string) => void;
}

export function PreviewThreadRow({
  thread,
  activeThreadId,
  arrangeMode,
  draggedThreadId,
  onSelect,
  onDelete,
  onRename,
  onTogglePin,
  onToggleFavorite,
  onUpdatePreferredCats,
  onUpdateLabels,
  onOrganize,
  onReplay,
  onEnterArrange,
  onDragStartThread,
  onDragEndThread,
  getDraggedThreadId,
  onDropThread,
}: PreviewThreadRowProps) {
  const groupable = !thread.isHubThread && !thread.systemKind;
  return (
    <AttentionGroupableThreadRow
      threadId={thread.id}
      threadTitle={thread.title}
      groupable={groupable}
      arrangeMode={arrangeMode}
      draggedThreadId={draggedThreadId}
      onEnterArrange={onEnterArrange}
      onDragStartThread={onDragStartThread}
      onDragEndThread={onDragEndThread}
      getDraggedThreadId={getDraggedThreadId}
      onDropThread={onDropThread}
    >
      <ThreadItem
        id={thread.id}
        title={thread.title}
        participants={thread.participants}
        lastActiveAt={thread.lastActiveAt}
        isActive={thread.id === activeThreadId}
        onSelect={onSelect}
        onDelete={onDelete}
        onRename={onRename}
        onTogglePin={onTogglePin}
        onToggleFavorite={onToggleFavorite}
        onUpdatePreferredCats={onUpdatePreferredCats}
        onUpdateLabels={onUpdateLabels}
        onOrganize={onOrganize}
        onReplay={onReplay}
        isPinned={thread.pinned}
        isFavorited={thread.favorited}
        presence={thread.presence}
        unreadCount={thread.unreadCount}
        hasUserMention={thread.hasUserMention}
        projectPath={thread.projectPath}
        preferredCats={thread.preferredCats}
        threadLabels={thread.labels}
        systemKind={thread.systemKind}
        isHubThread={thread.isHubThread}
      />
    </AttentionGroupableThreadRow>
  );
}
