'use client';

import type { ConnectorTailwindTheme } from '@cat-cafe/shared';
import { getConnectorDefinition } from '@cat-cafe/shared';
import type { ChatMessage as ChatMessageType, MessageContent } from '@/stores/chatStore';
import { API_URL } from '@/utils/api-client';
import { ConnectorImage, GitHubIcon, SchedulerIcon, SettingsIcon, UsersIcon } from './icons/ConnectorIcons';
import { BallotIcon } from './icons/VoteIcons';
import { MarkdownContent } from './MarkdownContent';
import { RichBlocks } from './rich/RichBlocks';

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
          alt="attached image"
          className="max-w-full sm:max-w-sm rounded-lg mt-2 border border-cafe cursor-pointer hover:opacity-90 transition-opacity"
          onClick={() => isSafeUrl && window.open(src, '_blank', 'noopener')}
        />
      );
    }
    return null;
  });
}

interface ConnectorBubbleProps {
  message: ChatMessageType;
}

/** Default theme for connectors without a registered tailwindTheme. */
const DEFAULT_CONNECTOR_THEME: ConnectorTailwindTheme = {
  avatar: 'bg-conn-blue-bg ring-2 ring-conn-blue-ring',
  label: 'text-conn-blue-text',
  labelLink: 'text-conn-blue-text hover:text-conn-blue-hover',
  bubble: 'border border-conn-blue-bubble-border bg-conn-blue-bubble-bg',
};

/** F056: Designed icon per connector — replaces emoji with SVG/PNG icons.
 *  Thread-local system notices are filtered earlier in ChatMessage and do not render here. */
function ConnectorIcon({ connector, fallbackIcon }: { connector: string; fallbackIcon: string }) {
  switch (connector) {
    case 'feishu':
      return <ConnectorImage src="/images/connectors/feishu.png" alt="Feishu" className="w-5 h-5" />;
    case 'telegram':
      return <ConnectorImage src="/images/connectors/telegram.png" alt="Telegram" className="w-5 h-5" />;
    case 'imessage':
      return <ConnectorImage src="/images/connectors/imessage.png" alt="iMessage" className="w-5 h-5" />;
    case 'weixin':
      return <ConnectorImage src="/images/connectors/weixin.png" alt="WeChat" className="w-5 h-5" />;
    case 'dingtalk':
      return <ConnectorImage src="/images/connectors/dingtalk.png" alt="DingTalk" className="w-5 h-5" />;
    case 'wecom-bot':
      return <ConnectorImage src="/images/connectors/wecom-bot.png" alt="WeCom" className="w-5 h-5" />;
    case 'xiaoyi':
      return <ConnectorImage src="/images/connectors/xiaoyi.png" alt="XiaoYi" className="w-5 h-5" />;
    case 'github-review':
    case 'github-ci':
    case 'github-repo-event':
    case 'github-conflict':
    case 'github-review-feedback':
      // Preserve legacy non-default icons (e.g., triage stored ⚠️ instead of 🔔)
      if (fallbackIcon !== 'github' && fallbackIcon !== '🔔') {
        return <span>{fallbackIcon}</span>;
      }
      return <GitHubIcon className="w-4 h-4" />;
    case 'vote-result':
      return <BallotIcon className="w-4 h-4" />;
    case 'multi-mention-result':
      return <UsersIcon className="w-4 h-4" />;
    case 'scheduler':
      return <SchedulerIcon className="w-4 h-4" />;
    case 'system-command':
      return <SettingsIcon className="w-4 h-4" />;
    default:
      if (fallbackIcon.startsWith('/') || fallbackIcon.startsWith('http')) {
        return <ConnectorImage src={fallbackIcon} alt="connector" className="w-5 h-5" />;
      }
      return <span>{fallbackIcon}</span>;
  }
}

/**
 * F098-B5: Registry-driven connector theme lookup.
 * New connectors only need an entry in CONNECTOR_DEFINITIONS (shared package).
 */
function getConnectorTheme(connector: string | undefined): ConnectorTailwindTheme {
  if (!connector) return DEFAULT_CONNECTOR_THEME;
  const def = getConnectorDefinition(connector);
  return def?.tailwindTheme ?? DEFAULT_CONNECTOR_THEME;
}

/**
 * F97: Connector message bubble for external information sources (GitHub Review, etc.)
 * Left-aligned, blue-gray theme, distinct from cat/user/system messages.
 */
export function ConnectorBubble({ message }: ConnectorBubbleProps) {
  const source = message.source;
  if (!source) return null;
  if (message.extra?.scheduler?.hiddenTrigger) return null;

  const theme = getConnectorTheme(source.connector);
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const richBlocks = message.extra?.rich?.blocks;
  // P3 fix (砚砚 R1): protocol whitelist — only render safe URLs as clickable links
  const rawUrl = source.url;
  const srcUrl = rawUrl && /^https?:\/\//.test(rawUrl) ? rawUrl : undefined;

  return (
    <div data-message-id={message.id} className="flex gap-2 mb-4 items-start">
      {/* Connector icon avatar */}
      <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-base ${theme.avatar}`}>
        <ConnectorIcon connector={source.connector} fallbackIcon={source.icon} />
      </div>
      <div className="max-w-[85%] md:max-w-[75%] min-w-0">
        <div className="flex items-center gap-2 mb-1">
          {srcUrl ? (
            <a
              href={srcUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={`text-xs font-semibold hover:underline ${theme.labelLink}`}
            >
              {source.label}
            </a>
          ) : (
            <span className={`text-xs font-semibold ${theme.label}`}>{source.label}</span>
          )}
          {source.sender && (
            <span className="text-xs text-cafe-secondary">{source.sender.name || source.sender.id} 说</span>
          )}
          <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
        </div>
        <div
          className={`${theme.bubble} rounded-2xl rounded-bl-sm px-4 py-3 transition-transform hover:-translate-y-0.5 overflow-hidden`}
        >
          {hasBlocks ? renderContentBlocks(message.contentBlocks!) : <MarkdownContent content={message.content} />}
          {richBlocks && richBlocks.length > 0 && <RichBlocks blocks={richBlocks} />}
        </div>
      </div>
    </div>
  );
}
