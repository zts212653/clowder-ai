'use client';

import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { MarkdownContent } from './MarkdownContent';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function getNoticeTone(meta: Readonly<Record<string, unknown>> | undefined): 'info' | 'warning' | 'error' {
  const tone = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).noticeTone : undefined;
  return tone === 'warning' || tone === 'error' ? tone : 'info';
}

function iconText(icon?: string): string {
  if (!icon) return 'ℹ️';
  if (icon === 'lightbulb') return '💡';
  return icon;
}

interface SystemNoticeBarProps {
  message: ChatMessageType;
}

export function SystemNoticeBar({ message }: SystemNoticeBarProps) {
  const source = message.source;
  if (!source) return null;

  const tone = getNoticeTone(source.meta);

  return (
    <div data-message-id={message.id} data-notice-tone={tone} className="flex justify-center mb-3">
      <div className="max-w-[85%] w-full">
        <div className="flex items-center gap-2 mb-1 px-1">
          <span className="system-notice-bar__label text-xs font-medium">{source.label}</span>
          <span className="text-xs text-cafe-muted">{formatTime(message.timestamp)}</span>
        </div>
        <div
          className={`system-notice-bar ${tone !== 'info' ? 'system-notice-bar--alert' : ''} rounded-2xl px-4 py-3 text-cafe-secondary`}
        >
          <div className="flex items-start gap-3">
            <span className="system-notice-bar__icon text-lg leading-none">{iconText(source.icon)}</span>
            <div className="min-w-0 flex-1 text-sm leading-6">
              <MarkdownContent content={message.content} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
