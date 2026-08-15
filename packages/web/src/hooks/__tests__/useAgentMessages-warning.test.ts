import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getActiveBubble, setActiveBubble } from '@/hooks/thread-runtime-ledger';
import { getThreadRuntimeLedger, resetThreadRuntimeSingleton } from '@/hooks/thread-runtime-singleton';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import type { ChatMessage } from '@/stores/chat-types';

const mockAddMessage = vi.fn();
const mockAppendToMessage = vi.fn();
const mockAppendToolEvent = vi.fn();
const mockAppendRichBlock = vi.fn();
const mockSetStreaming = vi.fn();
const mockSetLoading = vi.fn();
const mockSetHasActiveInvocation = vi.fn();
const mockSetIntentMode = vi.fn();
const mockSetCatStatus = vi.fn();
const mockClearCatStatuses = vi.fn();
const mockSetCatInvocation = vi.fn();
const mockSetMessageUsage = vi.fn();
const mockRequestStreamCatchUp = vi.fn();
const mockSetMessageMetadata = vi.fn();
const mockSetMessageThinking = vi.fn();
const mockRemoveMessage = vi.fn();
const mockPatchMessage = vi.fn();

const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({ messages: [] }));

const storeState = {
  messages: [] as ChatMessage[],
  addMessage: mockAddMessage,
  appendToMessage: mockAppendToMessage,
  appendToolEvent: mockAppendToolEvent,
  appendRichBlock: mockAppendRichBlock,
  setStreaming: mockSetStreaming,
  setLoading: mockSetLoading,
  setHasActiveInvocation: mockSetHasActiveInvocation,
  setIntentMode: mockSetIntentMode,
  setCatStatus: mockSetCatStatus,
  clearCatStatuses: mockClearCatStatuses,
  setCatInvocation: mockSetCatInvocation,
  setMessageUsage: mockSetMessageUsage,
  requestStreamCatchUp: mockRequestStreamCatchUp,
  setMessageMetadata: mockSetMessageMetadata,
  setMessageThinking: mockSetMessageThinking,
  removeMessage: mockRemoveMessage,
  patchMessage: mockPatchMessage,

  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  currentThreadId: 'thread-1',
};

let captured: ReturnType<typeof useAgentMessages> | undefined;

vi.mock('@/stores/chatStore', () => {
  const useChatStoreMock = Object.assign(() => storeState, { getState: () => storeState });
  return {
    useChatStore: useChatStoreMock,
  };
});

function Harness() {
  captured = useAgentMessages();
  return null;
}

describe('useAgentMessages system_info warning', () => {
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
    captured = undefined;
    resetThreadRuntimeSingleton();
    storeState.messages = [];
    mockAddMessage.mockClear();
    mockRemoveMessage.mockClear();
    mockPatchMessage.mockClear();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('renders warning JSON as readable system message', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'gpt52',
        content: JSON.stringify({ type: 'warning', catId: 'gpt52', message: 'hello' }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        variant: 'info',
        content: '⚠️ hello',
      }),
    );
  });

  it('renders cloud bridge status as readable text instead of raw JSON', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'gpt-pro',
        content: JSON.stringify({
          type: 'cloud_bridge_status',
          catId: 'gpt-pro',
          status: 'unavailable',
          reason: 'no-adapter',
          message: '未发送给 @gpt-pro：还没有可用的后台 Host Adapter。',
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        variant: 'info',
        content: '未发送给 @gpt-pro：还没有可用的后台 Host Adapter。',
      }),
    );
  });

  it('updates one invocation-scoped reconnect notice to recovered', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex-sol',
        invocationId: 'parent-inv',
        turnInvocationId: 'turn-inv',
        content: JSON.stringify({
          type: 'provider_recovery',
          provider: 'codex',
          phase: 'reconnecting',
          invocationId: 'turn-inv',
          attempt: 1,
          attempts: ['Reconnecting... 1/5 (stream disconnected before completion)'],
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'provider-recovery:codex-sol:turn-inv',
        type: 'system',
        variant: 'info',
        content: expect.stringContaining('Reconnecting'),
        extra: expect.objectContaining({
          providerRecovery: expect.objectContaining({ phase: 'reconnecting', invocationId: 'turn-inv' }),
        }),
      }),
    );
    storeState.messages = [mockAddMessage.mock.calls.at(-1)?.[0] as ChatMessage];

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex-sol',
        invocationId: 'parent-inv',
        turnInvocationId: 'turn-inv',
        content: JSON.stringify({
          type: 'provider_recovery',
          provider: 'codex',
          phase: 'recovered',
          invocationId: 'turn-inv',
          attempt: 1,
          attempts: ['Reconnecting... 1/5 (stream disconnected before completion)'],
          evidence: 'item.completed',
        }),
      });
    });

    expect(mockPatchMessage).toHaveBeenCalledWith(
      'provider-recovery:codex-sol:turn-inv',
      expect.objectContaining({
        content: 'Connection recovered.',
        extra: expect.objectContaining({
          providerRecovery: expect.objectContaining({
            phase: 'recovered',
            invocationId: 'turn-inv',
            attempts: ['Reconnecting... 1/5 (stream disconnected before completion)'],
          }),
        }),
      }),
    );
    expect(mockAddMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps an unrecovered reconnect notice in failed state', () => {
    act(() => root.render(React.createElement(Harness)));

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex-sol',
        turnInvocationId: 'turn-failed',
        content: JSON.stringify({
          type: 'provider_recovery',
          provider: 'codex',
          phase: 'failed',
          invocationId: 'turn-failed',
          attempts: ['Reconnecting... 1/5'],
          evidence: 'cli_error',
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'provider-recovery:codex-sol:turn-failed',
        variant: 'error',
        content: 'Reconnect failed.',
        extra: expect.objectContaining({
          providerRecovery: expect.objectContaining({ phase: 'failed', evidence: 'cli_error' }),
        }),
      }),
    );
  });

  it('suppresses tool_activity telemetry on the active stream path', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'antig-opus',
        content: JSON.stringify({ type: 'tool_activity', toolName: 'view_file' }),
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('F254 renders one identity-bound catch state and removes it on commit', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex-sol',
        content: JSON.stringify({
          type: 'freshness_closure',
          closureId: 'closure-1',
          status: 'catching_up',
          sourceInvocationId: 'inv-old',
          updatedAt: 123,
        }),
      });
    });
    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'freshness-closure:closure-1',
        content: '正在重读新增消息…',
      }),
    );

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex-sol',
        content: JSON.stringify({
          type: 'freshness_closure',
          closureId: 'closure-1',
          status: 'committed',
          sourceInvocationId: 'inv-fresh',
          updatedAt: 456,
        }),
      });
    });
    expect(mockRemoveMessage).toHaveBeenCalledWith('freshness-closure:closure-1');
  });

  it('F254 explains a side-effect replay fence instead of showing a generic interrupted ghost', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({
          type: 'freshness_closure',
          closureId: 'closure-side-effect',
          status: 'blocked',
          blockedReason: 'side_effect_requires_explicit_retry',
          replayUnsafeToolNames: ['mcp__cat-cafe-collab__cat_cafe_hold_ball'],
          updatedAt: 500,
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'freshness-closure:closure-side-effect',
        content: expect.stringContaining('hold_ball'),
        extra: expect.objectContaining({
          freshnessClosure: expect.objectContaining({
            status: 'blocked',
            blockedReason: 'side_effect_requires_explicit_retry',
            replayUnsafeToolNames: ['mcp__cat-cafe-collab__cat_cafe_hold_ball'],
          }),
        }),
      }),
    );
    expect(mockAddMessage.mock.calls.at(-1)?.[0]?.content).toContain('已停止自动重试');
    expect(mockAddMessage.mock.calls.at(-1)?.[0]?.content).not.toBe('重读被中断，等待显式重试。');
  });

  it('F254 explains that startup recovery stopped instead of silently reviving old work', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'gpt52',
        content: JSON.stringify({
          type: 'freshness_closure',
          closureId: 'closure-startup-blocked',
          status: 'blocked',
          blockedReason: 'startup_recovery_requires_explicit_retry',
          updatedAt: 600,
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'freshness-closure:closure-startup-blocked',
        content: expect.stringContaining('runtime 重启'),
        extra: expect.objectContaining({
          freshnessClosure: expect.objectContaining({
            status: 'blocked',
            blockedReason: 'startup_recovery_requires_explicit_retry',
          }),
        }),
      }),
    );
    expect(mockAddMessage.mock.calls.at(-1)?.[0]?.content).toContain('不会自动继续');
  });

  it('F254 identifies a legacy user-cancel closure as historical responsibility with exact projection time', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    storeState.messages = [
      {
        id: 'legacy-source',
        type: 'assistant',
        catId: 'codex-sol',
        content: 'old draft',
        timestamp: 100,
        extra: { stream: { invocationId: 'inv-legacy' } },
      },
      {
        id: 'recent-answer',
        type: 'assistant',
        catId: 'codex-sol',
        content: 'new answer',
        timestamp: 1_000,
      },
    ];

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex-sol',
        content: JSON.stringify({
          type: 'freshness_closure',
          closureId: 'closure-legacy-cancel',
          status: 'blocked',
          sourceInvocationId: 'inv-legacy',
          turnInvocationId: 'turn-legacy',
          originTriggerMessageId: null,
          blockedReason: 'user_cancel',
          updatedAt: 200,
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'freshness-closure:closure-legacy-cancel',
        content: expect.stringContaining('历史未结责任'),
        timestamp: 200,
        extra: expect.objectContaining({
          systemKind: 'freshness_closure',
          freshnessClosure: expect.objectContaining({
            sourceInvocationId: 'inv-legacy',
            sourceMessageId: 'legacy-source',
            originTriggerMessageId: null,
            updatedAt: 200,
            legacy: true,
          }),
        }),
      }),
    );
    expect(mockAddMessage.mock.calls.at(-1)?.[0]?.content).toContain('已取消');
    expect(mockAddMessage.mock.calls.at(-1)?.[0]?.content).not.toBe('重读被中断，等待显式重试。');
  });

  it('F254 routes a legacy side-effect fence to migration instead of offering a contradictory retry', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex-sol',
        content: JSON.stringify({
          type: 'freshness_closure',
          closureId: 'closure-legacy-side-effect',
          status: 'blocked',
          originTriggerMessageId: null,
          blockedReason: 'side_effect_requires_explicit_retry',
          replayUnsafeToolNames: ['command_execution', 'cross_post_message'],
          updatedAt: 200,
        }),
      });
    });

    const content = mockAddMessage.mock.calls.at(-1)?.[0]?.content;
    expect(content).toContain('command_execution');
    expect(content).toContain('等待迁移核销');
    expect(content).not.toContain('显式重试');
  });

  it('F254 reconnect replay removes only the stale source bubble and preserves the live successor', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    storeState.messages = [
      {
        id: 'live-successor',
        type: 'assistant',
        catId: 'codex-sol',
        content: 'fresh replacement still streaming',
        timestamp: 200,
        isStreaming: true,
        extra: { stream: { invocationId: 'parent-shared', turnInvocationId: 'turn-live' } },
      },
      {
        id: 'stale-source',
        type: 'assistant',
        catId: 'codex-sol',
        content: 'known-stale draft',
        timestamp: 100,
        isStreaming: false,
        extra: { stream: { invocationId: 'parent-shared', turnInvocationId: 'turn-stale' } },
      },
    ];
    setActiveBubble(getThreadRuntimeLedger(), 'thread-1', 'codex-sol', {
      messageId: 'live-successor',
      invocationId: 'turn-live',
      seedSource: 'bound',
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'codex-sol',
        content: JSON.stringify({
          type: 'freshness_closure',
          closureId: 'closure-replayed',
          status: 'catching_up',
          sourceInvocationId: 'parent-shared',
          turnInvocationId: 'turn-stale',
          updatedAt: 300,
        }),
      });
    });

    expect(mockRemoveMessage).toHaveBeenCalledWith('stale-source');
    expect(mockRemoveMessage).not.toHaveBeenCalledWith('live-successor');
    expect(getActiveBubble(getThreadRuntimeLedger(), 'thread-1', 'codex-sol')?.messageId).toBe('live-successor');
  });

  it('suppresses mcp_server_status telemetry on the active stream path', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({
          type: 'mcp_server_status',
          provider: 'claude',
          pendingMeaning: 'deferred_tool_loading',
          counts: { connected: 1, pending: 1, failed: 0, disabled: 0, 'needs-auth': 0 },
          servers: [{ name: 'MCP_DOCKER', status: 'pending' }],
        }),
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
  });

  it('renders a2a_pingpong_terminated JSON as readable system message', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'sonnet',
        content: JSON.stringify({
          type: 'a2a_pingpong_terminated',
          fromCatId: 'sonnet',
          targetCatId: 'gpt52',
          pairCount: 4,
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        variant: 'info',
        content: '🏓 sonnet ↔ gpt52 已连续互相 @ 4 轮，链路已熔断。',
        extra: {
          systemInfo: {
            v: 1,
            payload: {
              type: 'a2a_pingpong_terminated',
              fromCatId: 'sonnet',
              targetCatId: 'gpt52',
              pairCount: 4,
            },
            fallbackCatId: 'sonnet',
          },
        },
      }),
    );
  });

  // Bug-J: provider_signal messages carry upstream-origin warnings (Antigravity
  // capacity retry notices, stream_error grace-window hints). Before this
  // handler they were silently dropped — users saw bubbles hang without any
  // explanation. Route them through the same formatVisibleSystemInfo pipeline
  // as system_info so capacity warnings become visible ⚠️ system bubbles.
  it('Bug-J: renders Antigravity provider_signal capacity warning as visible system message', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'provider_signal',
        catId: 'antig-opus',
        content: JSON.stringify({
          type: 'warning',
          message: '上游模型服务端容量不足，系统将在 20s 后自动重试（1/3）',
        }),
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        variant: 'info',
        catId: 'antig-opus',
        content: '⚠️ 上游模型服务端容量不足，系统将在 20s 后自动重试（1/3）',
      }),
    );
  });

  it('Bug-J: renders provider_signal plain-text payload verbatim (non-JSON)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'provider_signal',
        catId: 'antig-opus',
        content: 'raw upstream notice',
      });
    });

    expect(mockAddMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'system',
        variant: 'info',
        catId: 'antig-opus',
        content: 'raw upstream notice',
      }),
    );
  });

  it('Bug-J: empty provider_signal payload is not surfaced (no ghost bubble)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });

    mockAddMessage.mockClear();
    act(() => {
      captured?.handleAgentMessage({
        type: 'provider_signal',
        catId: 'antig-opus',
        content: '',
      });
    });

    expect(mockAddMessage).not.toHaveBeenCalled();
  });
});
