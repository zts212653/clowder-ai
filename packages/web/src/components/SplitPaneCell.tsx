'use client';

import { useMemo } from 'react';
import type { ThreadState } from '@/stores/chat-types';
import type { ChatMessage } from '@/stores/chatStore';
import { CatAvatar } from './CatAvatar';
import { getCatStatusType } from './ThreadCatStatus';

const VISIBLE_MESSAGES = 5;

interface SplitPaneCellProps {
  threadId: string;
  threadTitle: string;
  threadState: ThreadState;
  isSelected: boolean;
  onSelect: (threadId: string) => void;
  onDoubleClick: (threadId: string) => void;
}

function MiniMessage({ msg }: { msg: ChatMessage }) {
  const isUser = msg.type === 'user' && !msg.catId;
  return (
    <div className={`flex gap-1.5 ${isUser ? 'justify-end' : ''}`}>
      {!isUser && msg.catId && <CatAvatar catId={msg.catId} size={16} />}
      <p
        className={`text-xs leading-relaxed truncate max-w-[90%] px-2 py-1 rounded-lg ${
          isUser ? 'bg-cocreator-bg text-cafe-black' : 'bg-cafe-surface-elevated text-cafe-secondary'
        } ${msg.isStreaming ? 'opacity-70' : ''}`}
      >
        {msg.content.slice(0, 120)}
        {msg.content.length > 120 ? '...' : ''}
        {msg.isStreaming && <span className="animate-pulse ml-1">|</span>}
      </p>
    </div>
  );
}

export function SplitPaneCell({
  threadId,
  threadTitle,
  threadState,
  isSelected,
  onSelect,
  onDoubleClick,
}: SplitPaneCellProps) {
  const catStatus = getCatStatusType(threadState.catStatuses);
  const recentMessages = useMemo(() => threadState.messages.slice(-VISIBLE_MESSAGES), [threadState.messages]);

  const statusColor =
    catStatus === 'error'
      ? 'text-red-500'
      : catStatus === 'working'
        ? 'text-amber-500'
        : catStatus === 'done'
          ? 'text-green-500'
          : 'text-cafe-muted';

  return (
    <div
      className={`flex flex-col rounded-lg border-2 transition-colors cursor-pointer overflow-hidden ${
        isSelected ? 'border-cocreator-primary shadow-sm' : 'border-cafe hover:border-cafe'
      }`}
      onClick={() => onSelect(threadId)}
      onDoubleClick={() => onDoubleClick(threadId)}
    >
      {/* Pane header */}
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-cafe-surface-elevated border-b border-cafe-subtle flex-shrink-0">
        <span className={`text-xs ${statusColor}`}>{catStatus !== 'idle' ? 'ᓚᘏᗢ' : ''}</span>
        <span className="text-xs font-medium text-cafe-secondary truncate flex-1">{threadTitle}</span>
        {threadState.isLoading && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />}
        {threadState.unreadCount > 0 && (
          <span className="text-[9px] bg-amber-500 text-white rounded-full px-1 min-w-[14px] text-center">
            {threadState.unreadCount > 99 ? '99+' : threadState.unreadCount}
          </span>
        )}
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5 min-h-0">
        {recentMessages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-xs text-cafe-muted">无消息</span>
          </div>
        ) : (
          recentMessages.map((msg) => <MiniMessage key={msg.id} msg={msg} />)
        )}
      </div>
    </div>
  );
}

/** Empty pane placeholder */
export function SplitPanePlaceholder({ index }: { index: number }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-cafe transition-colors">
      <span className="text-2xl text-gray-200 mb-1">+</span>
      <span className="text-xs text-cafe-muted">窗格 {index + 1}</span>
      <span className="text-[10px] text-cafe-muted mt-0.5">点击左侧 thread 分配到此处</span>
    </div>
  );
}
