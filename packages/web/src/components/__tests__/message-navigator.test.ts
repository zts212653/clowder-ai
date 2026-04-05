import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MessageNavigator } from '@/components/MessageNavigator';
import type { ChatMessage as ChatMessageData } from '@/stores/chatStore';

vi.mock('@/hooks/useCoCreatorConfig', () => ({
  useCoCreatorConfig: () => ({
    name: '始皇帝',
    aliases: ['秦始皇'],
    mentionPatterns: ['@owner', '@me'],
  }),
}));

function makeMsg(id: string, type: 'user' | 'assistant' | 'system', catId?: string): ChatMessageData {
  return {
    id,
    type,
    content: `Content for ${id}`,
    timestamp: Date.now(),
    ...(catId ? { catId } : {}),
  } as ChatMessageData;
}

const nullRef = { current: null };

function render(messages: ChatMessageData[]): string {
  return renderToStaticMarkup(React.createElement(MessageNavigator, { messages, scrollContainerRef: nullRef }));
}

describe('MessageNavigator', () => {
  it('returns null when fewer than 3 nav items', () => {
    const html = render([makeMsg('m1', 'user'), makeMsg('m2', 'assistant', 'opus')]);
    expect(html).toBe('');
  });

  it('renders dots for user and assistant messages only', () => {
    const msgs = [
      makeMsg('m1', 'user'),
      makeMsg('m2', 'system'),
      makeMsg('m3', 'assistant', 'opus'),
      makeMsg('m4', 'system'),
      makeMsg('m5', 'assistant', 'codex'),
    ];
    const html = render(msgs);

    // 3 buttons: m1=user, m3=assistant, m5=assistant
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons.length).toBe(3);
  });

  it('filters out system messages from navigation', () => {
    const msgs = [
      makeMsg('m1', 'user'),
      makeMsg('m2', 'system'),
      makeMsg('m3', 'assistant', 'opus'),
      makeMsg('m4', 'assistant', 'codex'),
    ];
    const html = render(msgs);

    // 3 nav items: user + 2 assistants
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons.length).toBe(3);
  });

  it('applies cat-specific dot colors', () => {
    const msgs = [makeMsg('m1', 'user'), makeMsg('m2', 'assistant', 'opus'), makeMsg('m3', 'assistant', 'codex')];
    const html = render(msgs);

    expect(html).toContain('bg-cocreator-primary');
    expect(html).toContain('#9B7EBD');
    expect(html).toContain('#5B8C5A');
  });

  it('tolerates variant catIds before /api/cats loads', () => {
    const msgs = [makeMsg('m1', 'user'), makeMsg('m2', 'assistant', 'opus-45'), makeMsg('m3', 'assistant', 'spark')];
    const html = render(msgs);

    // base colors come from shared fallback CAT_CONFIGS (opus/codex)
    expect(html).toContain('#9B7EBD');
    expect(html).toContain('#5B8C5A');
    expect(html).toContain('跳转到 布偶猫（opus-45） 的消息');
    expect(html).toContain('跳转到 缅因猫（spark） 的消息');
  });

  it('resolves non-hyphen variant catIds during fallback', () => {
    const msgs = [
      makeMsg('m1', 'user'),
      makeMsg('m2', 'assistant', 'gpt52'),
      makeMsg('m3', 'assistant', 'sonnet'),
      makeMsg('m4', 'assistant', 'gemini25'),
    ];
    const html = render(msgs);

    // base colors come from shared fallback CAT_CONFIGS
    expect(html).toContain('#5B8C5A'); // codex
    expect(html).toContain('#9B7EBD'); // opus
    expect(html).toContain('#5B9BD5'); // gemini

    expect(html).toContain('跳转到 缅因猫（gpt52） 的消息');
    expect(html).toContain('跳转到 布偶猫（sonnet） 的消息');
    expect(html).toContain('跳转到 暹罗猫（gemini25） 的消息');
  });

  it('treats messages with catId as assistant even when type is user', () => {
    const msgs = [makeMsg('m1', 'user'), makeMsg('m2', 'user', 'gpt52'), makeMsg('m3', 'assistant', 'codex')];
    const html = render(msgs);

    expect(html).toContain('跳转到 缅因猫（gpt52） 的消息');

    const ownerLabels = html.match(/跳转到 始皇帝 的消息/g) ?? [];
    expect(ownerLabels.length).toBe(1);
  });

  it('applies dare fallback color and labels before /api/cats loads', () => {
    const msgs = [makeMsg('m1', 'user'), makeMsg('m2', 'assistant', 'dare'), makeMsg('m3', 'assistant', 'dare-agent')];
    const html = render(msgs);

    expect(html).toContain('#D4A76A');
    expect(html).toContain('跳转到 狸花猫 的消息');
    expect(html).toContain('跳转到 狸花猫（dare-agent） 的消息');
  });

  it('applies kimi and omx fallback colors and labels before /api/cats loads', () => {
    const msgs = [makeMsg('m1', 'user'), makeMsg('m2', 'assistant', 'kimi'), makeMsg('m3', 'assistant', 'omx')];
    const html = render(msgs);

    expect(html).toContain('#7C3AED');
    expect(html).toContain('#0F766E');
    expect(html).toContain('跳转到 金吉拉 的消息');
    expect(html).toContain('跳转到 曼岛猫 的消息');
  });

  it('includes accessibility labels', () => {
    const msgs = [makeMsg('m1', 'user'), makeMsg('m2', 'assistant', 'codex'), makeMsg('m3', 'assistant', 'opus')];
    const html = render(msgs);

    expect(html).toContain('跳转到 始皇帝 的消息');
    expect(html).toContain('跳转到 缅因猫 的消息');
  });

  it('samples at fixed intervals when messages exceed MAX_DOTS (18)', () => {
    // Create 40 user+assistant messages
    const msgs: ChatMessageData[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push(makeMsg(`m${i}`, i % 2 === 0 ? 'user' : 'assistant', 'opus'));
    }
    const html = render(msgs);

    // Should have exactly 18 dots, not 40
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons.length).toBe(18);
  });

  it('renders viewport indicator track', () => {
    const msgs = [makeMsg('m1', 'user'), makeMsg('m2', 'assistant', 'opus'), makeMsg('m3', 'assistant', 'codex')];
    const html = render(msgs);

    // Track rail (thin line) and viewport indicator should be present
    expect(html).toContain('bg-gray-200');
    expect(html).toContain('bg-gray-300/50');
  });
});
