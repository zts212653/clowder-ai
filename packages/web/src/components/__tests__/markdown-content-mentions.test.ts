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
        defaultModel: 'gemini-2.5-pro',
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
});
