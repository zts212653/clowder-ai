import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCatDataCache, type CatData, useCatData } from '@/hooks/useCatData';
import type { ChatMessage as ChatMessageType } from '@/stores/chatStore';

const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));
vi.mock('@/lib/mention-highlight', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/mention-highlight')>()),
  refreshMentionData: vi.fn(),
}));
vi.mock('@/utils/transcription-corrector', () => ({ refreshSpeechAliases: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/stores/chatStore', () => ({
  resolveBubbleExpanded: () => false,
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      uiThinkingExpandedByDefault: false,
      globalBubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' },
      threads: [],
      messages: [],
    }),
}));

vi.mock('@/hooks/useTts', () => ({
  useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }),
}));

vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: () => React.createElement('span', null, 'avatar'),
}));
vi.mock('@/components/SystemNoticeBar', () => ({
  SystemNoticeBar: ({ message }: { message: ChatMessageType }) =>
    React.createElement('div', { 'data-testid': 'notice-bar' }, `${message.source?.connector}:${message.content}`),
}));
vi.mock('@/components/ConnectorBubble', () => ({
  ConnectorBubble: ({ message }: { message: ChatMessageType }) =>
    React.createElement(
      'div',
      { 'data-testid': 'connector-bubble' },
      `${message.source?.connector}:${message.source?.label}:${message.content}`,
    ),
}));
vi.mock('@/components/EvidencePanel', () => ({ EvidencePanel: () => null }));
vi.mock('@/components/MarkdownContent', () => ({
  MarkdownContent: ({ content }: { content: string }) => React.createElement('p', null, content),
}));
vi.mock('@/components/MetadataBadge', () => ({ MetadataBadge: () => null }));
vi.mock('@/components/SummaryCard', () => ({ SummaryCard: () => null }));
vi.mock('@/components/rich/RichBlocks', () => ({ RichBlocks: () => null }));

describe('ChatMessage notice rendering', () => {
  let container: HTMLDivElement;
  let root: Root;
  let ChatMessage: React.FC<{ message: ChatMessageType; getCatById: (id: string) => CatData | undefined }>;

  beforeAll(async () => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const mod = await import('@/components/ChatMessage');
    ChatMessage = mod.ChatMessage;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    _resetCatDataCache();
    mockApiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('reprojects an existing system-info notice after a deferred roster load without another event', async () => {
    let resolveCatsResponse: ((response: Response) => void) | undefined;
    mockApiFetch.mockImplementation((path: string) => {
      if (path === '/api/config/cat-order') return Promise.resolve({ ok: false } as Response);
      if (path === '/api/cats') {
        return new Promise<Response>((resolve) => {
          resolveCatsResponse = resolve;
        });
      }
      return Promise.resolve({ ok: false } as Response);
    });
    const message = {
      id: 'system-info-session-seal',
      type: 'system',
      variant: 'info',
      content: 'cat-sol 的会话 #2 已封存（上下文 42%），下次调用将自动创建新会话',
      timestamp: Date.now(),
      extra: {
        systemInfo: {
          v: 1,
          payload: {
            type: 'session_seal_requested',
            catId: 'cat-sol',
            sessionSeq: 2,
            healthSnapshot: { fillRatio: 0.42 },
          },
          fallbackCatId: 'cat-sol',
        },
      },
    } as unknown as ChatMessageType;

    function NoticeHarness() {
      const { getCatById } = useCatData();
      return React.createElement(ChatMessage, { message, getCatById });
    }

    await act(async () => {
      root.render(React.createElement(NoticeHarness));
    });
    expect(container.textContent).toContain('cat-sol 的会话 #2');
    expect(mockApiFetch.mock.calls.filter((call) => call[0] === '/api/cats')).toHaveLength(1);

    const completeCatsRequest = resolveCatsResponse;
    if (!completeCatsRequest) throw new Error('Expected the registry request to be pending');
    await act(async () => {
      completeCatsRequest({
        ok: true,
        json: () =>
          Promise.resolve({
            cats: [{ id: 'cat-sol', displayName: '缅因猫', variantLabel: 'sol' }],
          }),
      } as Response);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('缅因猫（sol） 的会话 #2');
    expect(container.textContent).not.toContain('cat-sol 的会话 #2');
    expect(mockApiFetch.mock.calls.filter((call) => call[0] === '/api/cats')).toHaveLength(1);
  });

  it('renders inline mention hint as in-thread notice bar instead of connector bubble', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'notice-inline',
            type: 'connector',
            content: '把 @gpt52 单独放到新起一行开头，才能交接。',
            timestamp: Date.now(),
            source: {
              connector: 'inline-mention-hint',
              label: 'Routing hint',
              icon: 'lightbulb',
              meta: { presentation: 'system_notice', noticeTone: 'info' },
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="notice-bar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="connector-bubble"]')).toBeFalsy();
  });

  it('renders restart interruption notice as in-thread notice bar instead of connector bubble', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'notice-restart',
            type: 'connector',
            content: '服务重启，opus 的进行中请求已中断，请重新发送。',
            timestamp: Date.now(),
            source: {
              connector: 'startup-reconciler',
              label: '⚠️ 重启通知',
              icon: '⚠️',
              meta: { presentation: 'system_notice', noticeTone: 'warning' },
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="notice-bar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="connector-bubble"]')).toBeFalsy();
  });

  it('keeps true connector events on ConnectorBubble path', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'connector-vote',
            type: 'connector',
            content: '投票结果：2 票',
            timestamp: Date.now(),
            source: {
              connector: 'vote-result',
              label: '投票结果',
              icon: 'ballot',
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="connector-bubble"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="notice-bar"]')).toBeFalsy();
  });

  it('renders the durable supplement lifecycle on the published original bubble', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'msg-original',
            type: 'assistant',
            catId: 'opus',
            content: 'published answer',
            timestamp: Date.now(),
            extra: {
              freshness: {
                kind: 'published_with_unseen',
                priorFrontierMessageId: 'msg-late',
                generatedWithUnseen: ['msg-late'],
                lineageId: 'msg-original',
              },
              freshnessSupplement: {
                type: 'freshness_supplement',
                supplementId: 'f254-supplement:msg-original:1',
                lineageId: 'msg-original',
                originalMessageId: 'msg-original',
                threadId: 'thread-1',
                catId: 'opus',
                seq: 1,
                status: 'declined',
                requiredCount: 1,
                terminalReason: 'checked_no_supplement_needed',
                updatedAt: Date.now(),
              },
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="freshness-supplement-status"]')?.textContent).toContain(
      '已核对，无需补充',
    );
    expect(container.textContent).toContain('published answer');
  });

  it('renders a typed stream-origin supplement as a readable late-message reply', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'msg-supplement',
            type: 'assistant',
            catId: 'opus',
            content: 'additive supplement',
            origin: 'stream',
            timestamp: Date.now(),
            replyTo: 'msg-original',
            extra: {
              turnExecution: {
                invocationId: 'child-supplement-1',
                parentInvocationId: 'parent-1',
                executionKind: 'freshness_supplement',
              },
              supplement: {
                lineageId: 'msg-original',
                supplementId: 'f254-supplement:msg-original:1',
                seq: 1,
                originalMessageId: 'msg-original',
              },
            },
          },
        }),
      );
    });

    expect(container.textContent).toContain('后到消息补充 1');
    expect(container.querySelector('[data-turn-execution-kind="freshness_supplement"]')).toBeTruthy();
    expect(container.textContent).toContain('additive supplement');
    expect(container.querySelector('[data-testid="cli-output-body"]')).toBeFalsy();
    expect(container.querySelector('[data-testid="freshness-supplement-status"]')).toBeFalsy();
  });

  it('keeps an otherwise empty routing-guard execution visible without copying reply prose', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'msg-routing-guard',
            type: 'assistant',
            catId: 'codex',
            content: '',
            timestamp: Date.now(),
            extra: {
              turnExecution: {
                invocationId: 'child-routing-guard-1',
                parentInvocationId: 'parent-1',
                executionKind: 'routing_guard',
              },
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-turn-execution-kind="routing_guard"]')?.textContent).toContain('系统补路由');
    expect(container.textContent).not.toContain('重新生成');
  });

  it('shows a routing guard as an auxiliary execution without assigning its child id to the ordinary body', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'msg-ordinary-with-guard',
            type: 'assistant',
            catId: 'codex',
            content: 'original ordinary answer',
            timestamp: Date.now(),
            extra: {
              turnExecution: {
                invocationId: 'child-ordinary-1',
                parentInvocationId: 'parent-1',
                executionKind: 'ordinary',
              },
              auxiliaryTurnExecutions: [
                {
                  invocationId: 'child-routing-guard-1',
                  parentInvocationId: 'parent-1',
                  executionKind: 'routing_guard',
                },
              ],
            },
          },
        }),
      );
    });

    expect(container.textContent).toContain('original ordinary answer');
    expect(container.querySelector('[data-turn-execution-owner="child-ordinary-1"]')).toBeTruthy();
    expect(container.querySelector('[data-auxiliary-turn-execution="child-routing-guard-1"]')).toBeTruthy();
    expect(container.querySelectorAll('[data-turn-execution-kind="routing_guard"]')).toHaveLength(1);
  });

  it('shows a bodyless ordinary child beside a guard-owned replacement turn', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'msg-guard-with-bodyless-ordinary',
            type: 'assistant',
            catId: 'codex',
            content: '@co-creator',
            timestamp: Date.now(),
            extra: {
              turnExecution: {
                invocationId: 'child-routing-guard-2',
                parentInvocationId: 'parent-2',
                executionKind: 'routing_guard',
              },
              auxiliaryTurnExecutions: [
                {
                  invocationId: 'child-ordinary-bodyless',
                  parentInvocationId: 'parent-2',
                  executionKind: 'ordinary',
                },
              ],
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-turn-execution-owner="child-routing-guard-2"]')).toBeTruthy();
    expect(container.querySelector('[data-auxiliary-turn-execution="child-ordinary-bodyless"]')?.textContent).toContain(
      '普通执行（无正文）',
    );
  });

  it('shows a terminal explanation when supplement responsibility could not be stored', () => {
    act(() => {
      root.render(
        React.createElement(ChatMessage, {
          getCatById: (() => undefined) as never,
          message: {
            id: 'msg-offer-failed',
            type: 'assistant',
            catId: 'opus',
            content: 'published despite infrastructure failure',
            timestamp: Date.now(),
            extra: {
              freshness: {
                kind: 'published_with_unseen',
                priorFrontierMessageId: 'msg-late',
                generatedWithUnseen: ['msg-late'],
                lineageId: 'msg-offer-failed',
                supplementFailureReason: 'infrastructure',
              },
            },
          },
        }),
      );
    });

    expect(container.querySelector('[data-testid="freshness-supplement-status"]')?.textContent).toContain(
      '补充检查未能安排',
    );
    expect(container.textContent).toContain('published despite infrastructure failure');
  });
});
