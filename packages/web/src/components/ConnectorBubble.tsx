'use client';

import { type ConnectorIconSpec, getConnectorDefinition } from '@cat-cafe/shared';
import { useCallback, useState } from 'react';
import { tintedLight } from '@/lib/color-utils';
import type { ChatMessage as ChatMessageType, MessageContent } from '@/stores/chatStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import {
  AuthKeyIcon,
  ConnectorImage,
  GitHubIcon,
  HoldBallIcon,
  SchedulerIcon,
  SettingsIcon,
  UsersIcon,
} from './icons/ConnectorIcons';
import { BallotIcon } from './icons/VoteIcons';
import { MarkdownContent } from './MarkdownContent';
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

function HoldBallCancelButton({ taskId, threadId, catId }: { taskId: string; threadId?: string; catId?: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');

  const handleCancel = useCallback(
    async (withFeedback = false) => {
      setState('loading');
      try {
        const feedbackQuery = withFeedback ? '?withFeedback=1' : '';
        const res = await apiFetch(`/api/callbacks/hold-ball/${encodeURIComponent(taskId)}${feedbackQuery}`, {
          method: 'DELETE',
        });
        if (res.ok || (res.status === 404 && !withFeedback)) {
          setState('done');
          return;
        }
        if (res.status === 404 && withFeedback && threadId) {
          const fallbackRes = await apiFetch('/api/callbacks/hold-ball/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              threadId,
              taskId,
              ...(catId ? { catId } : {}),
            }),
          });
          setState(fallbackRes.ok ? 'done' : 'idle');
          return;
        }
        setState('idle');
      } catch {
        setState('idle');
      }
    },
    [catId, taskId, threadId],
  );

  if (state === 'done') return <span className="text-xs text-cafe-muted">已取消</span>;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => void handleCancel(false)}
        disabled={state === 'loading'}
        className="text-xs px-2 py-0.5 rounded bg-cafe-surface hover:bg-cafe-hover border border-cafe-border disabled:opacity-50 transition-colors"
      >
        {state === 'loading' ? '取消中…' : '取消持球'}
      </button>
      <button
        type="button"
        onClick={() => void handleCancel(true)}
        disabled={state === 'loading'}
        className="text-xs px-2 py-0.5 rounded bg-cafe-surface text-cafe-accent hover:bg-cafe-accent/10 border border-cafe-accent/40 disabled:opacity-50 transition-colors"
        title="取消持球并提交问题反馈"
      >
        取消并反馈
      </button>
    </div>
  );
}

interface ConnectorBubbleProps {
  message: ChatMessageType;
  threadId?: string;
}

/**
 * F97: Connector message bubble for external information sources (GitHub Review, etc.)
 * Uses MessageBubble for shared layout; adds connector-specific avatar, header, and actions.
 */
export function ConnectorBubble({ message, threadId }: ConnectorBubbleProps) {
  const source = message.source;
  if (!source) return null;
  if (message.extra?.scheduler?.hiddenTrigger) return null;

  const connId = source.connector;
  const connDef = getConnectorDefinition(connId);
  const themeHex = connDef?.themeColor;
  const hasBlocks = message.contentBlocks && message.contentBlocks.length > 0;
  const richBlocks = message.extra?.rich?.blocks;
  const rawUrl = source.url;
  const srcUrl = rawUrl && /^https?:\/\//.test(rawUrl) ? rawUrl : undefined;
  const sourceCatId = typeof source.meta?.catId === 'string' ? source.meta.catId : undefined;

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
          style={{ color: `var(--color-${connId}-bubble, var(--cafe-text))` }}
        >
          {source.label}
        </a>
      ) : (
        <span className="text-xs font-semibold" style={{ color: `var(--color-${connId}-bubble, var(--cafe-text))` }}>
          {source.label}
        </span>
      )}
      {source.sender && (
        <span className="text-xs text-cafe-secondary">{source.sender.name || source.sender.id} 说</span>
      )}
      <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
    </div>
  );

  return (
    <MessageBubble
      messageId={message.id}
      avatar={avatar}
      header={header}
      bubbleStyle={{
        backgroundColor: `var(--color-${connId}-surface, var(--cafe-surface))`,
        color: 'var(--cat-msg-text, var(--cafe-text))',
      }}
    >
      {hasBlocks ? renderContentBlocks(message.contentBlocks!) : <MarkdownContent content={message.content} />}
      {richBlocks && richBlocks.length > 0 && <RichBlocks blocks={richBlocks} messageSource={message.source} />}
      {source.connector === 'hold-ball' && typeof source.meta?.taskId === 'string' && (
        <div className="mt-2 pt-2 border-t border-cafe-border">
          <HoldBallCancelButton taskId={source.meta.taskId} threadId={threadId} catId={sourceCatId} />
        </div>
      )}
    </MessageBubble>
  );
}
