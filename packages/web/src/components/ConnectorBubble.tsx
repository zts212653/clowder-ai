'use client';

import {
  type ConnectorSource,
  decideHoldCancelEntry,
  isStaticConnectorId,
  readHoldCardCancelability,
  readWorktreeNotice,
} from '@cat-cafe/shared';
import type { ReactNode } from 'react';
import type { CatData } from '@/hooks/useCatData';
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
import { MessageNameplate } from './MessageNameplate';
import { ManagedJobCard } from './managed-job/ManagedJobCard';
import { ReplyPill } from './ReplyPill';
import { frustrationHistoryCopy } from './rich/frustration-history.shell-copy';
import { trustedFrustrationMeta, useFrustrationVisibility } from './rich/frustration-visibility';
import { RichBlocks } from './rich/RichBlocks';
import { SenderAvatar } from './SenderAvatar';
import { useShellCopy } from './shell/shell-copy';
import { useShellPresentation } from './shell/shell-presentation';
import { WorktreeNoticeBody } from './worktrees/WorktreeNoticeBody';

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
  getCatById?: (id: string) => CatData | undefined;
  replyPreview?: NonNullable<ChatMessageType['replyPreview']> & { expandedContent?: string };
}

/**
 * Renders connector-owned content inside the same message shell used by members.
 * Specialized hold/job/card bodies stay content-level concerns rather than defining
 * a separate visual identity or navigation surface for the whole message.
 */
export function ConnectorBubble({
  message,
  threadId,
  timelineMessages,
  footer,
  getCatById = () => undefined,
  replyPreview,
}: ConnectorBubbleProps) {
  const coCreator = useCoCreatorConfig();
  const shellPresentation = useShellPresentation();
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
  const worktreeNotice =
    message.from?.kind === 'system' && message.from.service === 'worktree-lifecycle' && connId === 'worktree-lifecycle'
      ? readWorktreeNotice(source.meta?.worktreeNotice, message.content)
      : null;
  const themeToken = connectorThemeToken(connId);
  const sender = resolveMessageSender({ from: message.from, source }, () => undefined, coCreator);
  const externalPerson =
    message.from?.kind === 'external' &&
    Boolean(message.from.sender?.id) &&
    !isStaticConnectorId(message.from.connectorId);
  const platform = source.label || (message.from?.kind === 'external' ? message.from.connectorId : source.connector);
  const senderRole = message.from?.kind === 'plugin' ? 'Plugin' : externalPerson ? `External · ${platform}` : 'Host';
  const avatarShape = externalPerson ? 'round' : 'rounded-square';
  const nameplateSender = externalPerson
    ? { ...sender, color: 'var(--shell-body)', textColor: 'var(--shell-body)' }
    : sender;
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

  const displayName = withdrawnFeedback ? t.title : sender.label;
  const header =
    shellPresentation === 'v2' ? (
      <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-4 min-w-0" data-message-author-row="">
        <MessageNameplate
          id={`connector:${source.connector}`}
          name={displayName}
          sender={nameplateSender}
          surface="var(--shell-selected)"
          ink="var(--shell-body)"
          avatarShape={avatarShape}
        />
        <span data-sender-role="" className="shrink-0 text-micro font-medium" style={{ color: 'var(--shell-muted)' }}>
          {senderRole}
        </span>
        <span className="text-xs shrink-0" style={{ color: 'var(--shell-muted)' }}>
          {formatTime(message.timestamp)}
        </span>
        {message.replyTo && replyPreview && (
          <ReplyPill
            replyPreview={replyPreview}
            expandedContent={replyPreview.expandedContent}
            replyToId={message.replyTo}
            getCatById={getCatById}
          />
        )}
        <MessageActionSlot />
      </div>
    ) : (
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold" style={{ color: nameColor }}>
          {displayName}
        </span>
        <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
        {message.replyTo && replyPreview && (
          <ReplyPill
            replyPreview={replyPreview}
            expandedContent={replyPreview.expandedContent}
            replyToId={message.replyTo}
            getCatById={getCatById}
          />
        )}
        <MessageActionSlot />
      </div>
    );

  return (
    <MessageBubble
      messageId={message.id}
      avatar={avatar}
      header={header}
      footer={footer}
      presentation={shellPresentation === 'v2' ? 'nameplate' : 'bubble'}
      railColor={shellPresentation === 'v2' ? 'var(--shell-hairline)' : undefined}
      bubbleStyle={
        shellPresentation === 'v2'
          ? undefined
          : { backgroundColor: surfaceColor, color: 'var(--cat-msg-text, var(--cafe-text))' }
      }
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
        <ContentBlocks
          blocks={message.contentBlocks!}
          publication={publication}
          messageSource={threadId ? { threadId, messageId: message.id } : undefined}
        />
      ) : unknownFeedback ? (
        <p className="text-xs text-cafe-muted">{t.unknown}</p>
      ) : withdrawnFeedback ? null : source.connector === HOST_CONTENT_REVIEW_CONNECTOR ? (
        <HostReturnBody content={message.content} />
      ) : source.connector === 'development-return' ? (
        <DevelopmentReturnBody
          content={message.content}
          reason={typeof source.meta?.reason === 'string' ? source.meta.reason : undefined}
        />
      ) : worktreeNotice ? (
        <WorktreeNoticeBody notice={worktreeNotice} getCatById={getCatById} />
      ) : (
        <MarkdownContent referenceThreadId={threadId} content={message.content} />
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
