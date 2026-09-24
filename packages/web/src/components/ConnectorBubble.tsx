'use client';

import {
  type ConnectorIconSpec,
  decideHoldCancelEntry,
  getConnectorDefinition,
  readHoldCardCancelability,
} from '@cat-cafe/shared';
import { tintedLight } from '@/lib/color-utils';
import { connectorThemeToken } from '@/lib/connector-theme-token';
import type { ChatMessage as ChatMessageType, MessageContent } from '@/stores/chatStore';
import { compareMessageTimelineOrder } from '@/stores/message-timeline';
import { API_URL } from '@/utils/api-client';
import { HoldBallCancelButton } from './HoldBallCancelButton';
import {
  AuthKeyIcon,
  ConnectorImage,
  GitHubIcon,
  HoldBallIcon,
  RobotIcon,
  SchedulerIcon,
  SearchIcon,
  SettingsIcon,
  UsersIcon,
} from './icons/ConnectorIcons';
import { BallotIcon } from './icons/VoteIcons';
import { MarkdownContent } from './MarkdownContent';
import { MessageActionSlot } from './MessageActionSlot';
import { MessageBubble } from './MessageBubble';
import { RichBlocks } from './rich/RichBlocks';

/** SVG icon component lookup — maps definition `iconId` to React component.
 *  Single source of truth: add new SVG icons here + in ConnectorIcons.tsx. */
const SVG_ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  github: GitHubIcon,
  ballot: BallotIcon,
  users: UsersIcon,
  scheduler: SchedulerIcon,
  settings: SettingsIcon,
  'hold-ball': HoldBallIcon,
  'auth-key': AuthKeyIcon,
  search: SearchIcon,
  robot: RobotIcon,
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function renderContentBlocks(blocks: MessageContent[]) {
  return blocks.map((block, i) => {
    if (block.type === 'text') {
      return <MarkdownContent key={i} content={block.text} />;
    }
    if (block.type === 'image') {
      const src = block.url.startsWith('/uploads/') ? `${API_URL}${block.url}` : block.url;
      const isSafeUrl = src.startsWith('/') || src.startsWith('http://') || src.startsWith('https://');
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={i}
          src={src}
          alt="attachment"
          className="max-w-full sm:max-w-sm rounded-lg mt-2 border border-cafe cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => isSafeUrl && window.open(src, '_blank', 'noopener')}
        />
      );
    }
    return null;
  });
}

/** Data-driven icon rendering from ConnectorDefinition.icon spec.
 *  Registered connectors always use the registry icon (SVG or PNG).
 *  Falls back to source.icon (emoji/URL) only for unregistered connectors. */
function ConnectorIcon({ iconSpec, fallbackIcon }: { iconSpec?: ConnectorIconSpec; fallbackIcon: string }) {
  // Registered connector → always use registry icon
  if (iconSpec) {
    if ('src' in iconSpec && iconSpec.src) {
      return <ConnectorImage src={iconSpec.src} alt="connector" className="w-5 h-5" />;
    }
    if (iconSpec.type === 'svg') {
      const SvgComponent = SVG_ICON_MAP[iconSpec.iconId];
      if (SvgComponent) return <SvgComponent className="w-4 h-4" />;
    }
  }

  // Fallback for unregistered connectors
  if (fallbackIcon.startsWith('/') || fallbackIcon.startsWith('http')) {
    return <ConnectorImage src={fallbackIcon} alt="connector" className="w-5 h-5" />;
  }
  return <span>{fallbackIcon}</span>;
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
  const latest = cards.at(-1) ?? message;
  return `${latest.id}:${latest.timestamp}:${latest.content}:${JSON.stringify(latest.source?.meta ?? {})}`;
}

interface ConnectorBubbleProps {
  message: ChatMessageType;
  threadId?: string;
  timelineMessages?: readonly ChatMessageType[];
}

/**
 * F97: Connector message bubble for external information sources (GitHub Review, etc.)
 * Uses MessageBubble for shared layout; adds connector-specific avatar, header, and actions.
 */
export function ConnectorBubble({ message, threadId, timelineMessages }: ConnectorBubbleProps) {
  const source = message.source;
  if (!source) return null;
  if (message.extra?.scheduler?.hiddenTrigger) return null;

  const connId = source.connector;
  const themeToken = connectorThemeToken(connId);
  const connDef = getConnectorDefinition(connId);
  const themeHex = connDef?.themeColor;
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const richBlocks = message.extra?.rich?.blocks;
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

  const avatar = (
    <div
      className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-base"
      style={{
        backgroundColor: themeHex ? tintedLight(themeHex, 0.5) : 'var(--cafe-surface)',
        boxShadow: themeHex ? `0 0 0 2px ${themeHex}` : '0 0 0 2px var(--cafe-border)',
      }}
    >
      <ConnectorIcon iconSpec={connDef?.icon} fallbackIcon={source.icon} />
    </div>
  );

  const header = (
    <div className="flex items-center gap-2 mb-1">
      {srcUrl ? (
        <a
          href={srcUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs font-semibold hover:underline"
          style={{ color: `var(--color-${themeToken}-bubble, var(--cafe-text))` }}
        >
          {source.label}
        </a>
      ) : (
        <span
          className="text-xs font-semibold"
          style={{ color: `var(--color-${themeToken}-bubble, var(--cafe-text))` }}
        >
          {source.label}
        </span>
      )}
      {source.sender && (
        <span className="text-xs text-cafe-secondary">{source.sender.name || source.sender.id} 说</span>
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
      bubbleStyle={{
        backgroundColor: `var(--color-${themeToken}-surface, var(--cafe-surface))`,
        color: 'var(--cat-msg-text, var(--cafe-text))',
      }}
    >
      {hasBlocks ? renderContentBlocks(message.contentBlocks!) : <MarkdownContent content={message.content} />}
      {richBlocks && richBlocks.length > 0 && <RichBlocks blocks={richBlocks} messageSource={message.source} />}
      {source.connector === 'hold-ball' && typeof source.meta?.taskId === 'string' && (
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
