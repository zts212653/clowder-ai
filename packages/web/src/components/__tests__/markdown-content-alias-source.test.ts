import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('MarkdownContent alias source', () => {
  it('picks up mention aliases after refreshMentionData()', async () => {
    const { refreshMentionData } = await import('@/lib/mention-highlight');
    const { MarkdownContent } = await import('@/components/MarkdownContent');

    // Populate mention data with dynamic cat info (simulates /api/cats fetch)
    refreshMentionData([
      {
        id: 'opus',
        mentionPatterns: ['@opus', '@布偶猫', '@测试布偶别名'],
        color: { primary: '#9B7EBD' },
      },
    ]);

    const html = renderToStaticMarkup(React.createElement(MarkdownContent, { content: '@测试布偶别名 你先看下' }));
    expect(html).toContain('color:#9B7EBD');
  });
});
