/**
 * Connector bubble theming — OKLCH pipeline
 * Tests that ConnectorBubble renders with correct theme colors and icons
 * from the unified ConnectorDefinition metadata.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { ConnectorBubble } from '../ConnectorBubble';

describe('ConnectorBubble theme', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('uses OKLCH-derived surface for vote-result bubble', () => {
    const message: ChatMessage = {
      id: 'm-vote',
      type: 'connector',
      content: '投票结果: 谁最坏？',
      timestamp: Date.now(),
      source: { connector: 'vote-result', label: '投票结果', icon: 'ballot' },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    const html = container.innerHTML;
    // OKLCH inline style references connector ID
    expect(html).toContain('--color-vote-result-surface');
    // SVG icon rendered (not emoji)
    expect(html).toContain('<svg');
    // Theme color in avatar ring (boxShadow inline style)
    expect(html).toContain('#7C3AED');
  });

  it('renders rich block fields inside connector bubble', () => {
    const message: ChatMessage = {
      id: 'm-vote-rich',
      type: 'connector',
      content: '投票结果: 谁最坏？',
      timestamp: Date.now(),
      source: { connector: 'vote-result', label: '投票结果', icon: 'ballot' },
      extra: {
        rich: {
          v: 1 as const,
          blocks: [
            {
              id: 'vote-1',
              kind: 'card' as const,
              v: 1 as const,
              title: '投票结果: 谁最坏？',
              bodyMarkdown: '实名投票 · 2 票',
              tone: 'info' as const,
              fields: [
                { label: 'opus', value: '1 票 (50%)' },
                { label: 'codex', value: '1 票 (50%)' },
              ],
            },
          ],
        },
      },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    const html = container.innerHTML;
    expect(html).toContain('opus');
    expect(html).toContain('codex');
    expect(html).toContain('50%');
  });

  it('suppresses hidden scheduler trigger bubbles', () => {
    const message: ChatMessage = {
      id: 'm-scheduler-hidden',
      type: 'connector',
      content: '[定时任务] 喝水提醒',
      timestamp: Date.now(),
      source: { connector: 'scheduler', label: '定时任务', icon: 'scheduler' },
      extra: { scheduler: { hiddenTrigger: true } },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    expect(container.innerHTML).toBe('');
  });

  it('uses OKLCH-derived surface for github-review bubble', () => {
    const message: ChatMessage = {
      id: 'm1',
      type: 'connector',
      content: '**GitHub Review 通知**',
      timestamp: Date.now(),
      source: {
        connector: 'github-review',
        label: 'GitHub Review',
        icon: 'github',
        url: 'https://github.com/zts212653/clowder-ai/pull/97',
      },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    const html = container.innerHTML;
    expect(html).toContain('--color-github-review-surface');
    expect(html).toContain('<svg');
    expect(html).toContain('#2563EB');
  });

  it('uses OKLCH-derived surface for github-ci bubble', () => {
    const message: ChatMessage = {
      id: 'm-ci',
      type: 'connector',
      content: '**CI/CD Build #42 passed**',
      timestamp: Date.now(),
      source: {
        connector: 'github-ci',
        label: 'GitHub CI/CD',
        icon: 'github',
        url: 'https://github.com/zts212653/clowder-ai/actions/runs/123',
      },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    const html = container.innerHTML;
    expect(html).toContain('--color-github-ci-surface');
    expect(html).toContain('<svg');
  });

  it('registered github triage still uses registry SVG icon (not legacy emoji)', () => {
    const message: ChatMessage = {
      id: 'm-triage',
      type: 'connector',
      content: '**GitHub Review 需要分派**',
      timestamp: Date.now(),
      source: { connector: 'github-review', label: 'GitHub Review', icon: '⚠️' },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    const html = container.innerHTML;
    // Registered connector always uses registry icon, not source.icon fallback
    expect(html).toContain('<svg');
    expect(html).not.toContain('⚠️');
  });

  it('uses OKLCH-derived surface for feishu bubble', () => {
    const message: ChatMessage = {
      id: 'm-fs',
      type: 'connector',
      content: '来自飞书的消息',
      timestamp: Date.now(),
      source: { connector: 'feishu', label: '飞书 DM', icon: '/images/connectors/feishu.png' },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    const html = container.innerHTML;
    expect(html).toContain('--color-feishu-surface');
    expect(html).toContain('#3370FF');
  });

  it('uses default fallback for unknown connector', () => {
    const message: ChatMessage = {
      id: 'm-unknown',
      type: 'connector',
      content: 'iMessage incoming',
      timestamp: Date.now(),
      source: { connector: 'imessage', label: 'iMessage', icon: '💬' },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    const html = container.innerHTML;
    // Unregistered connector → falls back to default surface
    expect(html).toContain('--color-imessage-surface');
    // Emoji icon as fallback
    expect(html).toContain('💬');
  });

  it('uses OKLCH-derived surface for hold-ball bubble', () => {
    const message: ChatMessage = {
      id: 'm-hold',
      type: 'connector',
      content: '🏓 codex 持球中',
      timestamp: Date.now(),
      source: { connector: 'hold-ball', label: '持球通知', icon: '🏓' },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    const html = container.innerHTML;
    expect(html).toContain('--color-hold-ball-surface');
    expect(html).toContain('#D97706');
    // SVG icon rendered instead of emoji
    expect(html).toContain('<svg');
  });
});
