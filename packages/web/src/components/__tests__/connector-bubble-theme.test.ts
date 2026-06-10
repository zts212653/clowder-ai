/**
 * Connector bubble theming — OKLCH pipeline
 * Tests that ConnectorBubble renders with correct theme colors and icons
 * from the unified ConnectorDefinition metadata.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ConnectorBubble } from '../ConnectorBubble';

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: vi.fn(),
}));

describe('ConnectorBubble theme', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockApiFetch = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    mockApiFetch.mockClear();
    mockApiFetch.mockResolvedValue(new Response('{}', { status: 200 }));
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

  it('renders cancel-and-feedback for hold-ball bubbles and sends feedback cancel', async () => {
    const message: ChatMessage = {
      id: 'm-hold',
      type: 'connector',
      content: '🏓 opus 持球中 — 等云端 review。',
      timestamp: Date.now(),
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        icon: '🏓',
        meta: { taskId: 'hold-ball-123' },
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const feedbackButton = buttons.find((button) => button.textContent?.includes('取消并反馈'));
    expect(feedbackButton).toBeDefined();

    await act(async () => {
      feedbackButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockApiFetch).toHaveBeenCalledWith('/api/callbacks/hold-ball/hold-ball-123?withFeedback=1', {
      method: 'DELETE',
    });
  });

  it('falls back to standalone feedback when hold-ball task is already stale', async () => {
    mockApiFetch
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const message: ChatMessage = {
      id: 'm-hold-stale',
      type: 'connector',
      content: '🏓 opus 持球中 — 等云端 review。',
      timestamp: Date.now(),
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        icon: '🏓',
        meta: { taskId: 'hold-ball-stale' },
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message, threadId: 'thread-stale' }));
    });

    const feedbackButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('取消并反馈'),
    );
    expect(feedbackButton).toBeDefined();

    await act(async () => {
      feedbackButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/callbacks/hold-ball/hold-ball-stale?withFeedback=1', {
      method: 'DELETE',
    });
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/callbacks/hold-ball/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-stale',
        taskId: 'hold-ball-stale',
      }),
    });
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
    expect(html).toContain('#778899');
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

  it('renders issue comment connector with GitHub icon instead of raw fallback text', () => {
    const message: ChatMessage = {
      id: 'm-issue-comment',
      type: 'connector',
      content: '**Issue Comments — Issue #861**',
      timestamp: Date.now(),
      source: {
        connector: 'github-issue-comment',
        label: 'Issue Comment',
        icon: 'github',
        url: 'https://github.com/zts212653/clowder-ai/issues/861',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    expect(html).toContain('var(--color-github-issue-comment-surface');
    expect(html).toContain('var(--color-github-issue-comment-bubble');
    expect(html).toContain('<svg');
    expect(html).not.toContain('>github<');
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
