'use client';

import type { CatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { resolveSender } from '@/lib/resolve-sender';
import { scrollToMessage } from '@/utils/scrollToMessage';

interface ReplyPillProps {
  replyPreview: { senderCatId: string | null; content: string; deleted?: true };
  replyToId: string;
  getCatById: (id: string) => CatData | undefined;
}

/**
 * F121: Reply pill badge — shows "↩ @猫名: 摘要" in breed color.
 * DirectionPill 同款药丸风格，click scrolls to original message.
 */
export function ReplyPill({ replyPreview, replyToId, getCatById }: ReplyPillProps) {
  const coCreator = useCoCreatorConfig();
  const { senderCatId, content, deleted } = replyPreview;

  const sender = resolveSender(senderCatId, getCatById, coCreator);
  const senderLabel = deleted ? '' : sender.label;
  const previewText = deleted ? '消息已删除' : content;

  const handleClick = () => {
    scrollToMessage(replyToId);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="text-micro font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap max-w-[200px] truncate cursor-pointer hover:opacity-80 transition-opacity"
      style={{ backgroundColor: `${sender.color}20`, color: sender.color }}
      title={deleted ? '消息已删除' : `${senderLabel}: ${content}`}
    >
      ↩ {senderLabel}
      {senderLabel && !deleted ? ': ' : ''}
      {previewText}
    </button>
  );
}
