/**
 * Connector bubble theming — OKLCH pipeline
 * Tests that ConnectorBubble renders with correct theme colors and icons
 * from the unified ConnectorDefinition metadata.
 */

import { type ConnectorDefinition, registerConnectorDefinition, unregisterConnectorDefinition } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { ConnectorBubble } from '../ConnectorBubble';
import { ShellPresentationContext } from '../shell/shell-presentation';

// Plugin identities are registered at runtime rather than compiled into the Host.
// These cases exercise registered presentation, so supply that prerequisite here.
const pluginPresentations: readonly ConnectorDefinition[] = [
  ...['github-review', 'github-wait', 'github-issue-comment'].map((id) => ({
    id,
    displayName: id,
    icon: { type: 'svg' as const, iconId: 'github' },
    themeColor: '#778899',
    description: 'Registered GitHub presentation fixture',
  })),
  {
    id: 'feishu',
    displayName: 'Feishu',
    icon: { type: 'png', src: '/images/connectors/feishu.png' },
    themeColor: '#3370FF',
    description: 'Registered external platform fixture',
  },
];

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://api.test',
  apiFetch: vi.fn(),
}));

describe('ConnectorBubble theme', () => {
  let container: HTMLDivElement;
  let root: Root;
  const mockApiFetch = vi.mocked(apiFetch);

  beforeAll(() => {
    for (const presentation of pluginPresentations) registerConnectorDefinition(presentation);
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    for (const presentation of pluginPresentations) unregisterConnectorDefinition(presentation.id);
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

  function feedbackMessage(signalType?: string): ChatMessage {
    return {
      id: 'm-feedback',
      type: 'connector',
      content: '[自动检测] 我注意到刚才可能出了问题',
      timestamp: Date.now(),
      source: { connector: 'frustration-auto-issue', label: '问题检测', icon: 'search' },
      extra: {
        rich: {
          v: 1,
          blocks: [
            {
              id: 'feedback-card',
              kind: 'card',
              v: 1,
              title: '自动问题卡',
              bodyMarkdown: '检测提问正文',
              meta: {
                kind: 'frustration_auto_issue',
                issueId: 'issue-feedback',
                ...(signalType ? { signalType } : {}),
              },
            },
          ],
        },
      },
    };
  }

  it('uses the common v2 member shell and ignores legacy hidden source links', () => {
    const message: ChatMessage = {
      id: 'm-common-shell',
      type: 'connector',
      content: '[owner/repo#42](https://github.com/owner/repo/pull/42)',
      timestamp: Date.now(),
      from: { kind: 'plugin', instanceId: 'github' },
      source: {
        connector: 'github-wait',
        label: 'GitHub',
        icon: 'github',
        themeColor: '#778899',
        url: 'https://github.com/owner/repo/pull/42',
      } as ChatMessage['source'] & { url: string },
    };

    act(() =>
      root.render(
        React.createElement(
          ShellPresentationContext.Provider,
          { value: 'v2' },
          React.createElement(ConnectorBubble, { message }),
        ),
      ),
    );

    expect(container.querySelector('[data-testid="member-nameplate"]')).not.toBeNull();
    expect(container.querySelector('a[href="https://github.com/owner/repo/pull/42"]')).not.toBeNull();
    expect(container.querySelectorAll('a[href="https://github.com/owner/repo/pull/42"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="message-bubble"]')?.getAttribute('style') ?? '').not.toContain(
      'background-color',
    );
  });

  for (const type of ['text_frustration', 'retry_burst']) {
    it(`withdraws the complete trusted ${type} presentation without deleting its message anchor`, async () => {
      await act(async () => root.render(React.createElement(ConnectorBubble, { message: feedbackMessage(type) })));
      expect(container.textContent).not.toContain('问题检测');
      expect(container.textContent).not.toContain('[自动检测]');
      expect(container.textContent).not.toContain('自动问题卡');
      expect(container.textContent).not.toContain('确认记录');
      expect(container.querySelector('[data-message-id="m-feedback"]')).not.toBeNull();
      expect(mockApiFetch.mock.calls.every(([path]) => path === '/api/config')).toBe(true);
    });
  }

  it('classifies a legacy card from its original issue read before exposing any detection question or action', async () => {
    let resolveIssue!: (response: Response) => void;
    mockApiFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveIssue = resolve;
        }),
    );
    await act(async () => root.render(React.createElement(ConnectorBubble, { message: feedbackMessage() })));
    expect(container.textContent).not.toContain('自动问题卡');
    expect(container.textContent).not.toContain('确认记录');
    await act(async () =>
      resolveIssue(new Response(JSON.stringify({ issue: { signalType: 'text_frustration' } }), { status: 200 })),
    );
    expect(container.textContent).not.toContain('问题检测');
    expect(container.textContent).not.toContain('[自动检测]');
    expect(container.querySelector('[data-message-id="m-feedback"]')).not.toBeNull();
  });

  for (const type of ['cli_error', 'a2a_timeout', 'user_report']) {
    it(`retains a legacy ${type} card from the original issue type`, async () => {
      mockApiFetch.mockImplementation(
        async () =>
          new Response(JSON.stringify({ issue: { issueId: 'issue-feedback', signalType: type, status: 'draft' } }), {
            status: 200,
          }),
      );
      await act(async () => root.render(React.createElement(ConnectorBubble, { message: feedbackMessage() })));
      await vi.waitFor(() => expect(container.textContent).toContain('确认记录'));
      expect(container.textContent).toContain('自动问题卡');
      expect(mockApiFetch.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
    });
  }

  it('keeps unavailable legacy type unknown without showing detection text or actions', async () => {
    mockApiFetch.mockResolvedValue(new Response('{}', { status: 404 }));
    await act(async () => root.render(React.createElement(ConnectorBubble, { message: feedbackMessage() })));
    expect(container.textContent).toContain('暂时无法确认');
    expect(container.textContent).not.toContain('问题检测');
    expect(container.textContent).not.toContain('[自动检测]');
    expect(container.textContent).not.toContain('确认记录');
  });

  it('fences a replaced issue ID before and after an older status read resolves', async () => {
    let resolveOld!: (response: Response) => void;
    mockApiFetch.mockImplementation(async (url) =>
      String(url).includes('issue-feedback/')
        ? new Promise<Response>((resolve) => {
            resolveOld = resolve;
          })
        : new Response(
            JSON.stringify({ issue: { issueId: 'issue-next', signalType: 'user_report', status: 'draft' } }),
            { status: 200 },
          ),
    );
    await act(async () => root.render(React.createElement(ConnectorBubble, { message: feedbackMessage() })));
    const next = feedbackMessage();
    const nextBlock = next.extra?.rich?.blocks[0];
    if (!nextBlock || nextBlock.kind !== 'card') throw new Error('expected a feedback card');
    nextBlock.meta = { kind: 'frustration_auto_issue', issueId: 'issue-next' };
    await act(async () => root.render(React.createElement(ConnectorBubble, { message: next })));
    await vi.waitFor(() => expect(container.textContent).toContain('确认记录'));
    await act(async () =>
      resolveOld(new Response(JSON.stringify({ issue: { signalType: 'text_frustration' } }), { status: 200 })),
    );
    expect(container.textContent).toContain('确认记录');
  });

  it('preserves ordinary cards and message content blocks beside a retired trusted card', async () => {
    const message = feedbackMessage('retry_burst');
    message.extra!.rich!.blocks.push({
      id: 'ordinary',
      v: 1,
      kind: 'card',
      title: '原执行状态',
      bodyMarkdown: '可信状态原文',
    });
    await act(async () => root.render(React.createElement(ConnectorBubble, { message })));
    expect(container.textContent).toContain('原执行状态');
    expect(container.textContent).toContain('可信状态原文');
    expect(container.textContent).not.toContain('问题检测');
    expect(container.textContent).not.toContain('自动问题卡');
    const untrusted = feedbackMessage('retry_burst');
    untrusted.source = { connector: 'vote-result', label: '普通来源', icon: 'ballot' };
    mockApiFetch.mockClear();
    await act(async () => root.render(React.createElement(ConnectorBubble, { message: untrusted })));
    expect(container.textContent).toContain('自动问题卡');
    expect(mockApiFetch.mock.calls.every(([path]) => path === '/api/config')).toBe(true);
  });

  it('uses OKLCH-derived surface for vote-result bubble', () => {
    const message: ChatMessage = {
      id: 'm-vote',
      type: 'connector',
      content: '投票结果: 谁最坏？',
      timestamp: Date.now(),
      from: { kind: 'external', connectorId: 'vote-result' },
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
      from: { kind: 'external', connectorId: 'vote-result' },
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
      from: { kind: 'external', connectorId: 'scheduler' },
      source: { connector: 'scheduler', label: '定时任务', icon: 'scheduler' },
      extra: { scheduler: { hiddenTrigger: true } },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    expect(container.innerHTML).toBe('');
  });

  it('renders cancel-and-feedback for hold-ball bubbles and sends feedback cancel', async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'active', cancelable: true }), { status: 200 }),
    );
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
    await act(async () => {
      await Promise.resolve();
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    const feedbackButton = buttons.find((button) => button.textContent?.includes('取消并反馈'));
    expect(feedbackButton).toBeDefined();

    await act(async () => {
      feedbackButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/callbacks/hold-ball/hold-ball-123/status');
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/callbacks/hold-ball/hold-ball-123?withFeedback=1', {
      method: 'DELETE',
    });
  });

  it('falls back to standalone feedback when hold-ball task is already stale', async () => {
    mockApiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'active', cancelable: true }), { status: 200 }))
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
    await act(async () => {
      await Promise.resolve();
    });

    const feedbackButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('取消并反馈'),
    );
    expect(feedbackButton).toBeDefined();

    await act(async () => {
      feedbackButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mockApiFetch).toHaveBeenNthCalledWith(1, '/api/callbacks/hold-ball/hold-ball-stale/status');
    expect(mockApiFetch).toHaveBeenNthCalledWith(2, '/api/callbacks/hold-ball/hold-ball-stale?withFeedback=1', {
      method: 'DELETE',
    });
    expect(mockApiFetch).toHaveBeenNthCalledWith(3, '/api/callbacks/hold-ball/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadId: 'thread-stale',
        taskId: 'hold-ball-stale',
      }),
    });
  });

  it('renders retired event status without cancel controls for hold-ball bubbles', async () => {
    mockApiFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: 'retired_by_event', cancelable: false }), { status: 200 }),
    );
    const message: ChatMessage = {
      id: 'm-hold-retired',
      type: 'connector',
      content: '🏓 opus 持球中 — 等云端 review。',
      timestamp: Date.now(),
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        icon: '🏓',
        meta: { taskId: 'hold-ball-retired' },
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain('已被事件唤醒');
    expect(Array.from(container.querySelectorAll('button')).map((button) => button.textContent)).not.toContain(
      '取消持球',
    );
    expect(mockApiFetch).toHaveBeenCalledWith('/api/callbacks/hold-ball/hold-ball-retired/status');
  });

  it('uses OKLCH-derived surface for github-review bubble', () => {
    const message: ChatMessage = {
      id: 'm1',
      type: 'connector',
      content: '**GitHub Review 通知**',
      timestamp: Date.now(),
      from: { kind: 'external', connectorId: 'github-review' },
      source: {
        connector: 'github-review',
        label: 'GitHub Review',
        icon: 'github',
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
      },
    };
    act(() => root.render(React.createElement(ConnectorBubble, { message })));
    const html = container.innerHTML;
    expect(html).toContain('--color-github-ci-surface');
    expect(html).toContain('<svg');
  });

  it.each([
    { connector: 'github-wait', label: 'GitHub Wait', icon: 'github', themeToken: 'github-wait' },
    { connector: 'frustration-auto-issue', label: '问题检测', icon: '🔍', themeToken: 'frustration-auto-issue' },
    { connector: 'physical-limb.stackchan', label: 'StackChan', icon: 'robot', themeToken: 'physical-limb-stackchan' },
  ] as const)('renders registered $connector with its SVG and CSS-safe theme token instead of the fallback icon', ({
    connector,
    label,
    icon,
    themeToken,
  }) => {
    const message: ChatMessage = {
      id: `m-${connector}`,
      type: 'connector',
      content: `${label} notification`,
      timestamp: Date.now(),
      from: { kind: 'external', connectorId: connector },
      source: { connector, label, icon },
    };

    act(() => root.render(React.createElement(ConnectorBubble, { message })));

    const html = container.innerHTML;
    expect(html).toContain(`--color-${themeToken}-surface`);
    expect(html).toContain('<svg');
    expect(html).not.toContain(`>${icon}<`);
  });

  it('renders issue comment connector with GitHub icon instead of raw fallback text', () => {
    const message: ChatMessage = {
      id: 'm-issue-comment',
      type: 'connector',
      content: '**Issue Comments — Issue #861**',
      timestamp: Date.now(),
      from: { kind: 'external', connectorId: 'github-issue-comment' },
      source: {
        connector: 'github-issue-comment',
        label: 'Issue Comment',
        icon: 'github',
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
      from: { kind: 'external', connectorId: 'github-review' },
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
      from: { kind: 'external', connectorId: 'feishu' },
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
      from: { kind: 'external', connectorId: 'imessage' },
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
      from: { kind: 'external', connectorId: 'hold-ball' },
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
