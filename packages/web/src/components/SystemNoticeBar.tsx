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

function getToneClass(tone: 'info' | 'warning' | 'error') {
  if (tone === 'warning') {
    return {
      label: 'text-[#9A6A32]',
      time: 'text-cafe-muted',
      box: 'border border-[#E8DCCF] bg-cafe-surface/90 text-cafe-secondary',
      icon: 'text-[#B7791F]',
    };
  }
  if (tone === 'error') {
    return {
      label: 'text-[#A45D5D]',
      time: 'text-cafe-muted',
      box: 'border border-[#F0DEDA] bg-[#FFF8F7] text-cafe-secondary',
      icon: 'text-[#C76B6B]',
    };
  }
  return {
    label: 'text-[#5F7D9A]',
    time: 'text-cafe-muted',
    box: 'border border-[#D9E5F1] bg-cafe-surface/90 text-cafe-secondary',
    icon: 'text-[#6488B0]',
  };
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
  const style = getToneClass(tone);

  return (
    <div data-message-id={message.id} className="flex justify-center mb-3">
      <div className="max-w-[85%] w-full">
        <div className="flex items-center gap-2 mb-1 px-1">
          <span className={`text-xs font-medium ${style.label}`}>{source.label}</span>
          <span className={`text-xs ${style.time}`}>{formatTime(message.timestamp)}</span>
        </div>
        <div
          className={`system-notice-bar ${tone !== 'info' ? 'system-notice-bar--alert' : ''} rounded-2xl px-4 py-3 ${style.box}`}
        >
          <div className="flex items-start gap-3">
            <span className={`text-lg leading-none ${style.icon}`}>{iconText(source.icon)}</span>
            <div className="min-w-0 flex-1 text-sm leading-6">
              <MarkdownContent content={message.content} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
