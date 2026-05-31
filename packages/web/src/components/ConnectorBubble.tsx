'use client';

import { getConnectorDefinition } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { tintedLight } from '@/lib/color-utils';
import type { ChatMessage as ChatMessageType, MessageContent } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
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

function HoldBallCancelButton({ taskId }: { taskId: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');

  const handleCancel = useCallback(async () => {
    setState('loading');
    try {
      const res = await apiFetch(`/api/callbacks/hold-ball/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
      setState(res.ok || res.status === 404 ? 'done' : 'idle');
    } catch {
      setState('idle');
    }
  }, [taskId]);

  if (state === 'done') return <span className="text-xs text-cafe-muted">已取消</span>;
  return (
    <button
      type="button"
      onClick={handleCancel}
      disabled={state === 'loading'}
      className="text-xs px-2 py-0.5 rounded bg-cafe-surface hover:bg-cafe-hover border border-cafe-border disabled:opacity-50 transition-colors"
    >
      {state === 'loading' ? '取消中…' : '取消持球'}
    </button>
  );
}

/**
 * F97: Connector message bubble for external information sources (GitHub Review, etc.)
 * Left-aligned, blue-gray theme, distinct from cat/user/system messages.
 */
export function ConnectorBubble({ message }: ConnectorBubbleProps) {
  const source = message.source;
  if (!source) return null;
  if (message.extra?.scheduler?.hiddenTrigger) return null;

  const connId = source.connector;
  /* Avatar uses fixed hex from connector definition — same pattern as CatAvatar
   * (cat.color.primary). Only the message bubble bg is OKLCH-derived. */
  const connDef = getConnectorDefinition(connId);
  const themeHex = connDef?.color?.secondary ?? connDef?.color?.primary;
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const richBlocks = message.extra?.rich?.blocks;
  // P3 fix (砚砚 R1): protocol whitelist — only render safe URLs as clickable links
  const rawUrl = source.url;
  const srcUrl = rawUrl && /^https?:\/\//.test(rawUrl) ? rawUrl : undefined;

  return (
    <div data-message-id={message.id} className="flex gap-2 mb-4 items-start">
      {/* Connector icon avatar — fixed hex like CatAvatar (ring = theme color,
       * bg = 50% tint toward white). NOT OKLCH-derived. */}
      <div
        className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-base"
        style={{
          backgroundColor: themeHex ? tintedLight(themeHex, 0.5) : 'var(--cafe-surface)',
          boxShadow: themeHex ? `0 0 0 2px ${themeHex}` : '0 0 0 2px var(--cafe-border)',
        }}
      >
        <ConnectorIcon connector={source.connector} fallbackIcon={source.icon} />
      </div>
      <div className="max-w-[85%] md:max-w-[75%] min-w-0">
        <div className="flex items-center gap-2 mb-1">
          {srcUrl ? (
            <a
              href={srcUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-semibold hover:underline"
              style={{ color: `var(--color-${connId}-bubble, var(--cafe-text))` }}
            >
              {source.label}
            </a>
          ) : (
            <span
              className="text-xs font-semibold"
              style={{ color: `var(--color-${connId}-bubble, var(--cafe-text))` }}
            >
              {source.label}
            </span>
          )}
          {source.sender && (
            <span className="text-xs text-cafe-secondary">{source.sender.name || source.sender.id} 说</span>
          )}
          <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
        </div>
        <div
          className="rounded-2xl px-4 py-3 transition-transform hover:-translate-y-0.5 overflow-hidden"
          style={{
            backgroundColor: `var(--color-${connId}-surface, var(--cafe-surface))`,
            color: 'var(--cat-msg-text, var(--cafe-text))',
          }}
        >
          {hasBlocks ? renderContentBlocks(message.contentBlocks!) : <MarkdownContent content={message.content} />}
          {richBlocks && richBlocks.length > 0 && <RichBlocks blocks={richBlocks} messageSource={message.source} />}
          {source.connector === 'hold-ball' && typeof source.meta?.taskId === 'string' && (
            <div className="mt-2 pt-2 border-t border-cafe-border">
              <HoldBallCancelButton taskId={source.meta.taskId} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
