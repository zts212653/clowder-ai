'use client';

import { useCatData } from '@/hooks/useCatData';
import { CatAvatar } from './CatAvatar';
import { MessageBubble } from './MessageBubble';

interface PendingMemberBubbleProps {
  catId: string;
  invocationId: string;
}

/**
 * #936: Show a member-level pending bubble with avatar and animated dots
 * as soon as an invocation starts, before any stream content arrives.
 *
 * This replaces the gap where the user sees nothing between sending a message
 * and the first assistant stream chunk. The bubble is keyed by invocationId
 * so it naturally unmounts when replaced by real content.
 */
export function PendingMemberBubble({ catId, invocationId }: PendingMemberBubbleProps) {
  const { getCatById } = useCatData();
  const catData = getCatById(catId);
  const catName = catData?.name ?? catId;

  return (
    <MessageBubble
      messageId={`pending-${invocationId}`}
      avatar={<CatAvatar catId={catId} size={32} status="streaming" />}
      header={<span className="text-sm font-medium text-cafe-fg-secondary">{catName}</span>}
      wrapperClassName="group cat-persona-derived"
    >
      <div className="flex items-center gap-1 py-2 text-cafe-fg-muted">
        <span className="text-sm">分析处理中</span>
        <span className="inline-flex gap-0.5">
          <span className="animate-bounce text-sm" style={{ animationDelay: '0ms' }}>
            .
          </span>
          <span className="animate-bounce text-sm" style={{ animationDelay: '150ms' }}>
            .
          </span>
          <span className="animate-bounce text-sm" style={{ animationDelay: '300ms' }}>
            .
          </span>
        </span>
      </div>
    </MessageBubble>
  );
}
