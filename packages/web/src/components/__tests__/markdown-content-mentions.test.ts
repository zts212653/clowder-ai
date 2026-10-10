import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { MarkdownContent } from '@/components/MarkdownContent';
import { refreshMentionData, resetMentionDataForTest } from '@/lib/mention-highlight';

Object.assign(globalThis as Record<string, unknown>, { React });

function render(content: string): string {
  return renderToStaticMarkup(React.createElement(MarkdownContent, { content }));
}

describe('MarkdownContent mention highlighting', () => {
  beforeEach(() => {
    resetMentionDataForTest();
    refreshMentionData([
      {
        id: 'codex',
        displayName: '缅因猫',
        color: { primary: '#5B8C5A', secondary: '#D5E8D4' },
        mentionPatterns: ['@砚砚', '@codex'],
        clientId: 'openai',
        carrier: 'cli',
        defaultModel: 'gpt-5.5',
        avatar: '',
        roleDescription: '',
        personality: '',
      },
      {
        id: 'opus',
        displayName: '布偶猫',
        color: { primary: '#9B7EBD', secondary: '#E8D5F5' },
        mentionPatterns: ['@宪宪', '@opus'],
        clientId: 'anthropic',
        carrier: 'cli',
        defaultModel: 'claude-opus-4-6',
        avatar: '',
        roleDescription: '',
        personality: '',
      },
      {
        id: 'gemini',
        displayName: '暹罗猫',
        color: { primary: '#5B9BD5', secondary: '#E6F2FF' },
        mentionPatterns: ['@siamese', '@gemini'],
        clientId: 'google',
        carrier: 'cli',
        defaultModel: 'gemini-2.5-pro',
        avatar: '',
        roleDescription: '',
        personality: '',
      },
      {
        id: 'gpt52',
        displayName: '金渐层',
        color: { primary: '#C89B3C', secondary: '#F8E7B0' },
        mentionPatterns: ['@金哥'],
        clientId: 'openai',
        carrier: 'cli',
        defaultModel: 'gpt-5.2',
        avatar: '',
        roleDescription: '',
        personality: '',
      },
      {
        id: 'cat-b5ddoo9l',
        displayName: '狸花猫',
        variantLabel: 'kimi',
        color: { primary: '#D4A76A', secondary: '#F5EBD7' },
        mentionPatterns: ['@kimi'],
        clientId: 'kimi',
        carrier: 'cli',
        defaultModel: 'k3',
        avatar: '',
        roleDescription: '',
        personality: '',
      },
    ]);
  });

  it('highlights nickname and english-alias mentions with cat colors', () => {
    const html = render('@砚砚 请看下，@宪宪 也看下，@siamese 收尾');
    // Dynamic colors now use inline style with hex values (not Tailwind classes)
    expect(html).toContain('color:#5B8C5A'); // codex
    expect(html).toContain('color:#9B7EBD'); // opus
    expect(html).toContain('color:#5B9BD5'); // gemini
  });

  it('renders a canonical catId mention as the member display name', () => {
    const html = render('@cat-b5ddoo9l and @gpt52 and @codex');
    expect(html).toContain('@狸花猫（kimi）');
    expect(html).toContain('@金渐层');
    expect(html).not.toContain('>@cat-b5ddoo9l<');
    expect(html).not.toContain('>@gpt52<');
    expect(html).toContain('>@codex<');
    expect(html).toContain('color:#D4A76A');
  });
});
