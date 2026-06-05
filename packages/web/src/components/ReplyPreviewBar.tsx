'use client';

import type { CatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { resolveSender } from '@/lib/resolve-sender';

interface ReplyPreviewBarProps {
  replyToMessage: { id: string; content: string; senderCatId: string | null };
  cats: CatData[];
  onClear: () => void;
}

/**
 * #699: Input-area reply preview — shows who you're replying to with their theme color.
 * Click scrolls to original message; ✕ dismisses the quote.
 * Styled to match ReplyPill in the chat timeline.
 */
export function ReplyPreviewBar({ replyToMessage, cats, onClear }: ReplyPreviewBarProps) {
  const coCreator = useCoCreatorConfig();
  const { senderCatId, content, id: replyToId } = replyToMessage;

  const getCatById = (id: string) => cats.find((c) => c.id === id);
  const sender = resolveSender(senderCatId, getCatById, coCreator);

  const handleClick = () => {
    const target = document.querySelector(`[data-message-id="${CSS.escape(replyToId)}"]`);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('ring-2', 'ring-offset-1');
    setTimeout(() => target.classList.remove('ring-2', 'ring-offset-1'), 1500);
  };

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 rounded-t-lg cursor-pointer"
      style={{ backgroundColor: `${sender.color}18` }}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && handleClick()}
    >
      <span className="shrink-0 text-sm" style={{ color: sender.color }}>
        ↩
      </span>
      <span className="truncate flex-1 text-xs font-medium" style={{ color: sender.color }}>
        {sender.label}: {content.slice(0, 80)}
        {content.length > 80 ? '…' : ''}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClear();
        }}
        className="shrink-0 p-1 rounded hover:bg-[var(--console-hover-bg)] transition-colors"
        style={{ color: sender.color }}
        title="取消引用"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
