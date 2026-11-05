'use client';

import type { ReplyPreview } from '@cat-cafe/shared';
import { useId, useState } from 'react';
import { useMeasuredOverflow } from '@/components/content-overflow/useMeasuredOverflow';
import { useShellPresentation } from '@/components/shell/shell-presentation';
import { useMessageNavigation } from '@/components/thread-chat/MessageNavigationContext';
import type { CatData } from '@/hooks/useCatData';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { tintOf } from '@/lib/hex-color';
import { messageSenderThemeColor, resolveMessageSender } from '@/lib/resolve-sender';
import { SenderAvatar } from './SenderAvatar';

interface ReplyPillProps {
  replyPreview: ReplyPreview;
  expandedContent?: string;
  replyToId: string;
  getCatById: (id: string) => CatData | undefined;
}

/**
 * F121: Reply pill badge — shows "↩ 头像 猫名: 摘要" in breed color.
 * Classic truncation expands in place; jumping to the source stays a separate action.
 *
 * F322 B: in the new shell the words are written in the cat's readable name role (`--color-{cat}-text`), not in its identity
 * hex; the 12.5% tint behind them stays the identity colour, because it says who.
 */
export function ReplyPill({ replyPreview, expandedContent, replyToId, getCatById }: ReplyPillProps) {
  const navigateToMessage = useMessageNavigation();
  const coCreator = useCoCreatorConfig();
  const nameRole = useShellPresentation() === 'v2';
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const { ref, overflowing } = useMeasuredOverflow<HTMLSpanElement>({ axis: 'inline', active: !nameRole && !expanded });
  const { content, deleted } = replyPreview;

  const sender = resolveMessageSender(replyPreview, getCatById, coCreator, { nameRole });
  const senderLabel = deleted ? '' : sender.label;
  const previewText = deleted ? '消息已删除' : content;
  const canExpand =
    !nameRole &&
    !deleted &&
    (overflowing || expanded || (expandedContent !== undefined && expandedContent !== content));
  const showExpanded = canExpand && expanded;
  const themeColor = messageSenderThemeColor(replyPreview, sender, getCatById);

  const handleClick = () => {
    navigateToMessage(replyToId);
  };

  return (
    <span
      className={`inline-flex min-w-0 max-w-full flex-wrap items-center gap-1 ${showExpanded ? 'basis-full order-last' : ''}`}
    >
      <button
        type="button"
        onClick={canExpand ? () => setExpanded((current) => !current) : handleClick}
        aria-expanded={canExpand ? showExpanded : undefined}
        aria-controls={canExpand ? contentId : undefined}
        className={`inline-flex min-w-0 gap-1 text-left font-medium px-1.5 py-0.5 cursor-pointer hover:opacity-80 transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-current ${showExpanded ? 'text-xs items-start rounded-lg max-w-full' : 'text-micro items-center rounded-full whitespace-nowrap max-w-[200px]'}`}
        style={
          nameRole
            ? { backgroundColor: tintOf(sender.color, '20'), color: sender.textColor }
            : {
                backgroundColor: `color-mix(in srgb, ${themeColor} 12.5%, transparent)`,
                color: sender.isCoCreator ? sender.textColor : themeColor,
              }
        }
        title={deleted ? '消息已删除' : `${senderLabel}: ${content}`}
      >
        <span aria-hidden="true" className="shrink-0">
          ↩
        </span>
        {!deleted && <SenderAvatar sender={sender} className="h-3 w-3" />}
        <span
          id={contentId}
          ref={ref}
          className={showExpanded ? 'min-w-0 whitespace-pre-wrap break-words' : 'min-w-0 truncate'}
        >
          {senderLabel}
          {senderLabel && !deleted ? ': ' : ''}
          {showExpanded ? (expandedContent ?? previewText) : previewText}
        </span>
      </button>
      {showExpanded && (
        <button
          type="button"
          onClick={handleClick}
          className="shrink-0 text-micro font-medium text-[var(--color-cocreator-primary)] hover:underline"
        >
          跳到原文
        </button>
      )}
    </span>
  );
}
