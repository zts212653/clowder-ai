/**
 * Connector bubble theming
 *
 * F056 OKLCH migration: ConnectorBubble no longer uses Tailwind bg-conn-*
 * classes. Instead it uses inline CSS custom properties:
 *   - bubble bg:  var(--color-{connId}-surface, var(--cafe-surface))
 *   - label color: var(--color-{connId}-bubble, var(--cafe-text))
 * Avatar ring/bg come from connector definitions (getConnectorDefinition).
 *
 * Tests assert on the CSS variable pattern in the rendered HTML.
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

  it('uses OKLCH surface token for vote-result connector', () => {
    const message: ChatMessage = {
      id: 'm-vote',
      type: 'connector',
      content: '投票结果: 谁最坏？',
      timestamp: Date.now(),
      source: {
        connector: 'vote-result',
        label: '投票结果',
        icon: 'ballot',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    expect(html).toContain('var(--color-vote-result-surface');
    expect(html).toContain('var(--color-vote-result-bubble');
  });

  it('renders rich block fields inside connector bubble', () => {
    const message: ChatMessage = {
      id: 'm-vote-rich',
      type: 'connector',
      content: '投票结果: 谁最坏？',
      timestamp: Date.now(),
      source: {
        connector: 'vote-result',
        label: '投票结果',
        icon: 'ballot',
      },
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

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    // Rich block fields should be visible inside the connector bubble
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
      source: {
        connector: 'scheduler',
        label: '定时任务',
        icon: 'scheduler',
      },
      extra: {
        scheduler: {
          hiddenTrigger: true,
        },
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    expect(container.innerHTML).toBe('');
  });

  it('uses OKLCH surface token for github-review connector', () => {
    const message: ChatMessage = {
      id: 'm1',
      type: 'connector',
      content: '**GitHub Review 通知**',
      timestamp: Date.now(),
      source: {
        connector: 'github-review',
        label: 'GitHub Review',
        icon: '🔔',
        url: 'https://github.com/zts212653/clowder-ai/pull/97',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    expect(html).toContain('var(--color-github-review-surface');
    expect(html).toContain('var(--color-github-review-bubble');
  });

  it('uses OKLCH surface token for github-ci connector', () => {
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

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    expect(html).toContain('var(--color-github-ci-surface');
    expect(html).toContain('var(--color-github-ci-bubble');
    // Should render GitHubIcon SVG, not raw text "github"
    expect(html).toContain('<svg');
    expect(html).not.toContain('>github<');
  });

  it('preserves legacy warning icon for github-review triage messages', () => {
    const message: ChatMessage = {
      id: 'm-triage',
      type: 'connector',
      content: '**GitHub Review 需要分派**',
      timestamp: Date.now(),
      source: {
        connector: 'github-review',
        label: 'GitHub Review',
        icon: '⚠️',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    // Legacy triage icon should be preserved, not replaced with GitHub SVG
    expect(html).toContain('⚠️');
  });

  it('uses OKLCH surface token for multi-mention-result connector', () => {
    const message: ChatMessage = {
      id: 'm-mm',
      type: 'connector',
      content: '3 只猫猫已回复',
      timestamp: Date.now(),
      source: {
        connector: 'multi-mention-result',
        label: 'Multi-Mention 结果',
        icon: '👥',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    expect(html).toContain('var(--color-multi-mention-result-surface');
    expect(html).toContain('var(--color-multi-mention-result-bubble');
  });

  it('uses OKLCH surface token for feishu connector', () => {
    const message: ChatMessage = {
      id: 'm-fs',
      type: 'connector',
      content: '来自飞书的消息',
      timestamp: Date.now(),
      source: {
        connector: 'feishu',
        label: '飞书 DM',
        icon: '🪶',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    expect(html).toContain('var(--color-feishu-surface');
    expect(html).toContain('var(--color-feishu-bubble');
  });

  it('uses OKLCH surface token for telegram connector', () => {
    const message: ChatMessage = {
      id: 'm-tg',
      type: 'connector',
      content: '来自 Telegram 的消息',
      timestamp: Date.now(),
      source: {
        connector: 'telegram',
        label: 'Telegram',
        icon: '✈️',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    expect(html).toContain('var(--color-telegram-surface');
    expect(html).toContain('var(--color-telegram-bubble');
  });

  it('uses fallback CSS var for unknown/unregistered connector', () => {
    const message: ChatMessage = {
      id: 'm-unknown',
      type: 'connector',
      content: 'iMessage incoming',
      timestamp: Date.now(),
      source: {
        connector: 'imessage',
        label: 'iMessage',
        icon: '💬',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    // Unknown connectors use var(--color-imessage-surface, var(--cafe-surface)) fallback
    expect(html).toContain('var(--color-imessage-surface');
    expect(html).toContain('var(--cafe-surface)');
  });

  it('uses OKLCH surface token for wecom-bot connector', () => {
    const message: ChatMessage = {
      id: 'm-wecom',
      type: 'connector',
      content: '来自企微的消息',
      timestamp: Date.now(),
      source: {
        connector: 'wecom-bot',
        label: '企业微信',
        icon: '/images/connectors/wecom-bot.png',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    expect(html).toContain('var(--color-wecom-bot-surface');
    expect(html).toContain('var(--color-wecom-bot-bubble');
  });

  it('uses OKLCH surface token for dingtalk connector', () => {
    const message: ChatMessage = {
      id: 'm-dingtalk',
      type: 'connector',
      content: '来自钉钉的消息',
      timestamp: Date.now(),
      source: {
        connector: 'dingtalk',
        label: '钉钉',
        icon: '/images/connectors/dingtalk.png',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    expect(html).toContain('var(--color-dingtalk-surface');
    expect(html).toContain('var(--color-dingtalk-bubble');
  });

  it('uses OKLCH surface token for wecom-agent connector', () => {
    const message: ChatMessage = {
      id: 'm-wecom-agent',
      type: 'connector',
      content: '来自企微自建应用的消息',
      timestamp: Date.now(),
      source: {
        connector: 'wecom-agent',
        label: '企微自建应用',
        icon: '/images/connectors/wecom-agent.png',
      },
    };

    act(() => {
      root.render(React.createElement(ConnectorBubble, { message }));
    });

    const html = container.innerHTML;
    expect(html).toContain('var(--color-wecom-agent-surface');
    expect(html).toContain('var(--color-wecom-agent-bubble');
  });
});
