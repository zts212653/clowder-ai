'use client';

import { type ConnectorSource, decideHoldCancelEntry, readHoldCardCancelability } from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import { useCoCreatorConfig } from '@/hooks/useCoCreatorConfig';
import { connectorThemeToken } from '@/lib/connector-theme-token';
import { resolveMessageSender } from '@/lib/resolve-sender';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { compareMessageTimelineCursor, compareMessageTimelineOrder } from '@/stores/message-timeline';
import { ContentBlocks } from './ContentBlocks';
import { isAbsorbedManagedJobMessage, isHiddenChatRow } from './chat-row-surface';
import { HOST_CONTENT_REVIEW_CONNECTOR, hostReturnHeadline } from './content-review/host-return-headline';
import { DevelopmentReturnBody } from './development-return/DevelopmentReturnBody';
import { HoldBallCancelButton } from './HoldBallCancelButton';
import { MarkdownContent } from './MarkdownContent';
import { MessageActionSlot } from './MessageActionSlot';
import { MessageBubble } from './MessageBubble';
import { ManagedJobCard } from './managed-job/ManagedJobCard';
import { frustrationHistoryCopy } from './rich/frustration-history.shell-copy';
import { trustedFrustrationMeta, useFrustrationVisibility } from './rich/frustration-visibility';
import { RichBlocks } from './rich/RichBlocks';
import { SenderAvatar } from './SenderAvatar';
import { useShellCopy } from './shell/shell-copy';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Host returns keep the machine instructions available behind the human headline. */
function HostReturnBody({ content }: { content: string }) {
  return (
    <details className="text-sm">
      <summary className="cursor-pointer select-none">{hostReturnHeadline(content)} · 已交给猫继续处理</summary>
      <div className="mt-2 text-xs text-cafe-secondary">
        <MarkdownContent content={content} />
      </div>
    </details>
  );
}

/**
 * Every card of one hold carries the same `taskId`. Collected once so the
 * refresh key and the cancel-entry owner read the same set instead of each
 * re-deriving it and drifting apart.
 */
function collectHoldCards(
  message: ChatMessageType,
  timelineMessages: readonly ChatMessageType[] | undefined,
): ChatMessageType[] {
  const source = message.source;
  const taskId = source?.meta?.taskId;
  if (source?.connector !== 'hold-ball' || typeof taskId !== 'string') return [];
  const byId = new Map<string, ChatMessageType>(
    (timelineMessages ?? [])
      .filter((candidate) => candidate.source?.connector === 'hold-ball' && candidate.source.meta?.taskId === taskId)
      .map((card) => [card.id, card]),
  );
  byId.set(message.id, message);
  return [...byId.values()].sort(compareMessageTimelineOrder);
}

function getHoldStatusRefreshKey(cards: readonly ChatMessageType[], message: ChatMessageType): string {
  // Arrival updates status even when the stable presentation clock places the
  // source earlier in history. Card ordering is not a freshness watermark.
  const latest = cards.reduce(
    (current, candidate) => (compareMessageTimelineCursor(current, candidate) < 0 ? candidate : current),
    message,
  );
  return `${latest.id}:${latest.timestamp}:${latest.content}:${JSON.stringify(latest.source?.meta ?? {})}`;
}

interface ConnectorBubbleProps {
  message: ChatMessageType;
  threadId?: string;
  timelineMessages?: readonly ChatMessageType[];
  footer?: ReactNode;
}

/**
 * F97: Connector message bubble for external information sources (GitHub Review, etc.)
 * Uses MessageBubble for shared layout; adds connector-specific avatar, header, and actions.
 */
export function ConnectorBubble({ message, threadId, timelineMessages, footer }: ConnectorBubbleProps) {
  const coCreator = useCoCreatorConfig();
  const source: ConnectorSource = message.source ?? { connector: '', label: '', icon: '' };
  const t = useShellCopy(frustrationHistoryCopy);
  const visibility = useFrustrationVisibility(message.extra?.rich?.blocks ?? [], source?.connector);
  const feedbackOnly =
    visibility.length > 0 && visibility.every(({ block }) => trustedFrustrationMeta(block, source?.connector));
  const retiredOnly = feedbackOnly && visibility.every((entry) => entry.visibility === 'retired');
  const unknownFeedback = visibility.some((entry) => entry.visibility === 'unknown');
  const withdrawnFeedback = visibility.some((entry) => entry.visibility !== 'allowed');
  if (isHiddenChatRow(message)) return null;
  const jobId = source.connector === 'hold-ball' && typeof source.meta?.jobId === 'string' ? source.meta.jobId : null;
  const taskId = typeof source.meta?.taskId === 'string' ? source.meta.taskId : null;
  if (isAbsorbedManagedJobMessage(message, timelineMessages ?? [])) {
    return <div data-message-id={message.id} aria-hidden="true" className="h-0" />;
  }
  if (retiredOnly && !message.contentBlocks?.length) {
    // Retirement withdraws the detection body, not its still-valid input receipt.
    return footer ? (
      <div data-message-id={message.id}>{footer}</div>
    ) : (
      <div data-message-id={message.id} aria-hidden="true" className="h-0" />
    );
  }

  const connId = source.connector;
  const themeToken = connectorThemeToken(connId);
  const sender = resolveMessageSender({ from: message.from, source }, () => undefined, coCreator);
  const pluginColor = message.from?.kind === 'plugin' ? source.themeColor : undefined;
  const nameColor = pluginColor ?? `var(--color-${themeToken}-bubble, var(--cafe-text))`;
  const surfaceColor = pluginColor
    ? `color-mix(in srgb, ${pluginColor} 10%, var(--cafe-surface))`
    : `var(--color-${themeToken}-surface, var(--cafe-surface))`;
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const richBlocks = visibility
    .filter((entry) => entry.visibility === 'allowed')
    .map(({ block, signal }) =>
      signal && block.kind === 'card' ? { ...block, meta: { ...block.meta, signalType: signal } } : block,
    );
  const rawUrl = source.url;
  const srcUrl = rawUrl && /^https?:\/\//.test(rawUrl) ? rawUrl : undefined;
  const sourceCatId = typeof source.meta?.catId === 'string' ? source.meta.catId : undefined;
  const holdCards = collectHoldCards(message, timelineMessages);
  const holdStatusRefreshKey = getHoldStatusRefreshKey(holdCards, message);
  const holdCancelEntry = decideHoldCancelEntry(
    message.id,
    holdCards.map((card) => ({
      id: card.id,
      timestamp: card.timestamp,
      cancelability: readHoldCardCancelability(card.source?.meta),
    })),
  );
  const publication =
    threadId && !message.isStreaming
      ? { threadId, messageId: message.id, messageRevision: String(message.timestamp) }
      : undefined;

  const avatar = <SenderAvatar sender={sender} presentation="message" />;

  const header = (
    <div className="flex items-center gap-2 mb-1">
      {srcUrl ? (
        <a
          href={srcUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-semibold hover:underline"
          style={{ color: nameColor }}
        >
          {withdrawnFeedback ? t.title : sender.label}
        </a>
      ) : (
        <span className="text-xs font-semibold" style={{ color: nameColor }}>
          {withdrawnFeedback ? t.title : sender.label}
        </span>
      )}
      <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
      <MessageActionSlot />
    </div>
  );

  return (
    <MessageBubble
      messageId={message.id}
      avatar={avatar}
      header={header}
      footer={footer}
      bubbleStyle={{
        backgroundColor: surfaceColor,
        color: 'var(--cat-msg-text, var(--cafe-text))',
      }}
    >
      {jobId && taskId ? (
        <ManagedJobCard
          taskId={taskId}
          jobId={jobId}
          threadId={threadId}
          catId={sourceCatId}
          title={typeof source.meta?.reason === 'string' ? source.meta.reason : undefined}
          refreshKey={holdStatusRefreshKey}
        />
      ) : hasBlocks ? (
        <ContentBlocks blocks={message.contentBlocks!} publication={publication} />
      ) : unknownFeedback ? (
        <p className="text-xs text-cafe-muted">{t.unknown}</p>
      ) : withdrawnFeedback ? null : source.connector === HOST_CONTENT_REVIEW_CONNECTOR ? (
        <HostReturnBody content={message.content} />
      ) : source.connector === 'development-return' ? (
        <DevelopmentReturnBody
          content={message.content}
          reason={typeof source.meta?.reason === 'string' ? source.meta.reason : undefined}
        />
      ) : (
        <MarkdownContent content={message.content} />
      )}
      {richBlocks && richBlocks.length > 0 && (
        <RichBlocks blocks={richBlocks} messageSource={message.source} publication={publication} />
      )}
      {!jobId && source.connector === 'hold-ball' && typeof source.meta?.taskId === 'string' && (
        <HoldBallCancelButton
          key={holdStatusRefreshKey}
          taskId={source.meta.taskId}
          threadId={threadId}
          catId={sourceCatId}
          cancelEntry={holdCancelEntry}
        />
      )}
    </MessageBubble>
  );
}
