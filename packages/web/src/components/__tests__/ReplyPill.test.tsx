import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { ReplyPill } from '../ReplyPill';

Object.assign(globalThis as Record<string, unknown>, { React });

vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: '始皇帝',
    aliases: ['秦始皇'],
    mentionPatterns: ['@owner', '@me'],
  }),
}));

const mockGetCatById = (id: string): CatData | undefined => {
  const cats: Record<string, Partial<CatData>> = {
    opus: { id: 'opus', displayName: '宪宪', color: { primary: '#8B5CF6', secondary: '#7C3AED' } },
    codex: { id: 'codex', displayName: '砚砚', color: { primary: '#22C55E', secondary: '#16A34A' } },
  };
  return cats[id] as CatData | undefined;
};

describe('ReplyPill', () => {
  it('renders cat reply with sender name and truncated content', () => {
    const html = renderToStaticMarkup(
      <ReplyPill
        replyPreview={{ senderCatId: 'opus', content: '这是预览内容' }}
        replyToId="msg-123"
        getCatById={mockGetCatById}
      />,
    );
    expect(html).toContain('↩');
    expect(html).toContain('@宪宪');
    expect(html).toContain('这是预览内容');
    expect(html).toContain('#8B5CF6');
  });

  it('renders user reply with configured co-creator label', () => {
    const html = renderToStaticMarkup(
      <ReplyPill
        replyPreview={{ senderCatId: null, content: '用户消息' }}
        replyToId="msg-456"
        getCatById={mockGetCatById}
      />,
    );
    expect(html).toContain('始皇帝');
    expect(html).toContain('用户消息');
  });

  it('renders deleted message placeholder', () => {
    const html = renderToStaticMarkup(
      <ReplyPill
        replyPreview={{ senderCatId: 'opus', content: '', deleted: true }}
        replyToId="msg-789"
        getCatById={mockGetCatById}
      />,
    );
    expect(html).toContain('消息已删除');
    expect(html).not.toContain('@宪宪:');
  });

  it('renders as a clickable button', () => {
    const html = renderToStaticMarkup(
      <ReplyPill
        replyPreview={{ senderCatId: 'opus', content: '内容' }}
        replyToId="msg-123"
        getCatById={mockGetCatById}
      />,
    );
    expect(html).toContain('<button');
    expect(html).toContain('cursor-pointer');
  });

  it('uses fallback color for unknown cat', () => {
    const html = renderToStaticMarkup(
      <ReplyPill
        replyPreview={{ senderCatId: 'unknown-cat', content: '内容' }}
        replyToId="msg-123"
        getCatById={mockGetCatById}
      />,
    );
    // Fallback color is ragdoll purple
    expect(html).toContain('#9B7EBD');
    expect(html).toContain('@unknown-cat');
  });
});
