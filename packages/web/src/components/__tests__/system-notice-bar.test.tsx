import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';
import { SystemNoticeBar } from '../SystemNoticeBar';

vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));

function renderNotice(message: Partial<ChatMessageType> & Pick<ChatMessageType, 'content' | 'timestamp' | 'source'>) {
  return renderToStaticMarkup(
    <SystemNoticeBar
      message={
        {
          id: 'notice-1',
          type: 'connector',
          ...message,
        } as ChatMessageType
      }
    />,
  );
}

describe('SystemNoticeBar', () => {
  it('uses Clowder cafe surface styling for info notices instead of a generic blue card', () => {
    const html = renderNotice({
      content: '想交接给 @codex？把它单独放到新起一行开头，才能触发交接。',
      timestamp: new Date('2026-04-16T12:34:00+08:00').getTime(),
      source: {
        connector: 'inline-mention-hint',
        label: 'Routing hint',
        icon: 'lightbulb',
        meta: { noticeTone: 'info' },
      },
    });

    expect(html).toContain('data-notice-tone="info"');
    expect(html).toContain('system-notice-bar');
    expect(html).toContain('text-cafe-secondary');
    expect(html).not.toContain('bg-blue-50');
    expect(html).not.toContain('text-slate-900');
    expect(html).not.toMatch(/text-\[#[0-9A-Fa-f]{3,6}\]/);
    expect(html).not.toMatch(/border-\[#[0-9A-Fa-f]{3,6}\]/);
  });

  it('keeps warning emphasis in metadata while leaving the notice body on the shared cafe palette', () => {
    const html = renderNotice({
      content: '服务刚重启，opus 的进行中请求已中断，请重新发送。',
      timestamp: new Date('2026-04-16T12:34:00+08:00').getTime(),
      source: {
        connector: 'startup-reconciler',
        label: '重启通知',
        icon: '⚠️',
        meta: { noticeTone: 'warning' },
      },
    });

    expect(html).toContain('data-notice-tone="warning"');
    expect(html).toContain('system-notice-bar--alert');
    expect(html).toContain('text-cafe-muted');
    expect(html).toContain('text-cafe-secondary');
    expect(html).not.toContain('bg-amber-50');
    expect(html).not.toContain('text-amber-950');
    expect(html).not.toMatch(/text-\[#[0-9A-Fa-f]{3,6}\]/);
    expect(html).not.toMatch(/border-\[#[0-9A-Fa-f]{3,6}\]/);
  });
});
