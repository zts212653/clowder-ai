// #939 part A (kimi auth dual-path): `provider_capability` system_info must be consumed
// silently — backend capability reports (e.g. `thinking: unavailable`) were rendering as
// raw-JSON user-facing system bubbles, which users read as "thinking failed". Pattern
// mirrors F210-H1 agy_trajectory_progress: store on invocation snapshot, no addMessage.
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

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
const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({ messages: [] }));
const mockUpdateThreadCatStatus = vi.fn();

const catInvocations: Record<string, Record<string, unknown>> = {};

const storeState = {
  messages: [] as Array<{ id: string; type: string; catId?: string; content: string; timestamp: number }>,
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
  setCatInvocation: (catId: string, patch: Record<string, unknown>) => {
    mockSetCatInvocation(catId, patch);
    // Mirror real zustand shallow-merge semantics for the read-merge-write path the
    // provider_capability branch uses, so the test can assert the merged result.
    const current = catInvocations[catId] ?? {};
    catInvocations[catId] = { ...current, ...patch };
  },
  setMessageUsage: mockSetMessageUsage,
  requestStreamCatchUp: mockRequestStreamCatchUp,
  setMessageMetadata: mockSetMessageMetadata,
  setMessageThinking: mockSetMessageThinking,
  addMessageToThread: mockAddMessageToThread,
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
  updateThreadCatStatus: mockUpdateThreadCatStatus,
  catInvocations,
  currentThreadId: 'thread-1',
};

let captured: ReturnType<typeof useAgentMessages> | undefined;

vi.mock('@/stores/chatStore', () => {
  const useChatStoreMock = Object.assign(() => storeState, { getState: () => storeState });
  return { useChatStore: useChatStoreMock };
});

function Harness() {
  captured = useAgentMessages();
  return null;
}

describe('#939 part A: provider_capability frontend consumption', () => {
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
    storeState.messages = [];
    for (const key of Object.keys(catInvocations)) delete catInvocations[key];
    vi.clearAllMocks();
  });
  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('does not render provider_capability as a system message bubble (kimi thinking: unavailable case)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'kimi',
        content: JSON.stringify({
          type: 'provider_capability',
          capability: 'thinking',
          status: 'unavailable',
          provider: 'kimi',
          reason: 'kimi-cli 本次流式输出未提供可解析的 think/reasoning 内容',
        }),
      });
    });
    // The bug: a raw-JSON system bubble surfaced with "thinking: unavailable",
    // which users read as "thinking failed". After the fix, no bubble.
    expect(mockAddMessage).not.toHaveBeenCalled();
    // Data is preserved on the invocation snapshot for a future capability UI.
    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'kimi',
      expect.objectContaining({
        providerCapabilities: expect.objectContaining({
          thinking: expect.objectContaining({
            status: 'unavailable',
            provider: 'kimi',
            reason: expect.stringContaining('think/reasoning'),
          }),
        }),
      }),
    );
  });

  it('does not render provider_capability for image_input: limited either', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'kimi',
        content: JSON.stringify({
          type: 'provider_capability',
          capability: 'image_input',
          status: 'limited',
          provider: 'kimi',
          reason: '当前 Kimi 模型未声明 image_in，已回退为本地路径提示',
        }),
      });
    });
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'kimi',
      expect.objectContaining({
        providerCapabilities: expect.objectContaining({
          image_input: expect.objectContaining({ status: 'limited' }),
        }),
      }),
    );
  });

  it('merges multiple capabilities on the same cat without clobbering each other', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'kimi',
        content: JSON.stringify({
          type: 'provider_capability',
          capability: 'thinking',
          status: 'unavailable',
          provider: 'kimi',
          reason: 'reason-thinking',
        }),
      });
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'kimi',
        content: JSON.stringify({
          type: 'provider_capability',
          capability: 'image_input',
          status: 'limited',
          provider: 'kimi',
          reason: 'reason-image',
        }),
      });
    });
    expect(mockAddMessage).not.toHaveBeenCalled();
    // Final merged snapshot has both capabilities.
    expect(catInvocations['kimi']?.providerCapabilities).toEqual(
      expect.objectContaining({
        thinking: expect.objectContaining({ reason: 'reason-thinking' }),
        image_input: expect.objectContaining({ reason: 'reason-image' }),
      }),
    );
  });

  it('later reports for the same capability replace the earlier one (latest-wins)', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'kimi',
        content: JSON.stringify({
          type: 'provider_capability',
          capability: 'thinking',
          status: 'unavailable',
          provider: 'kimi',
          reason: 'first',
        }),
      });
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'kimi',
        content: JSON.stringify({
          type: 'provider_capability',
          capability: 'thinking',
          status: 'available',
          provider: 'kimi',
          reason: 'second',
        }),
      });
    });
    expect(catInvocations['kimi']?.providerCapabilities).toEqual(
      expect.objectContaining({
        thinking: expect.objectContaining({ status: 'available', reason: 'second' }),
      }),
    );
  });

  it('coerces unknown status to "unavailable" rather than rendering a bubble', () => {
    act(() => {
      root.render(React.createElement(Harness));
    });
    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'kimi',
        content: JSON.stringify({
          type: 'provider_capability',
          capability: 'thinking',
          status: 'mystery-value',
          provider: 'kimi',
          reason: 'unknown status from a new backend version',
        }),
      });
    });
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockSetCatInvocation).toHaveBeenCalledWith(
      'kimi',
      expect.objectContaining({
        providerCapabilities: expect.objectContaining({
          thinking: expect.objectContaining({ status: 'unavailable' }),
        }),
      }),
    );
  });
});
