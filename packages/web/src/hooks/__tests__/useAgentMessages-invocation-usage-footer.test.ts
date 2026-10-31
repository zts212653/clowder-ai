/**
 * F230 footer-parity: invocation_usage with model/provider populates the response's metadata.
 *
 * PTY carrier produces text events WITHOUT metadata (transcriptEntriesToAgentMessages).
 * The active-path invocation_usage handler must write model/provider onto the message the
 * event names (msg.messageId = the turn's response R) so the MetadataBadge footer
 * ("claude-sonnet-4-6 · claude_interactive_pty") renders.
 *
 * Coverage:
 *   - Active path: invocation_usage with model/provider → metadata written on R, before usage
 *   - Active path: invocation_usage without model/provider → metadata NOT written (backward compat)
 *
 * Design: seed R in the store (as its lifecycle snapshot would) and send invocation_usage
 * naming it, without replaying the full text-event flow.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentMessages } from '@/hooks/useAgentMessages';

// ── Mock store (all store side-effects captured as vi.fn) ──────────────────────

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
const mockMergeMessageServedFacts = vi.fn();

const mockAddMessageToThread = vi.fn();
const mockSetThreadMessageMetadata = vi.fn();
const mockSetThreadMessageUsage = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({ messages: storeState.messages }));

interface TestMessage {
  id: string;
  type: string;
  catId?: string;
  content: string;
  origin?: string;
  isStreaming?: boolean;
  timestamp: number;
  lifecycle?: Record<string, unknown>;
}

const storeState = {
  messages: [] as TestMessage[],
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
  mergeMessageServedFacts: mockMergeMessageServedFacts,

  addMessageToThread: mockAddMessageToThread,
  appendToThreadMessage: vi.fn(),
  patchThreadMessage: vi.fn(),
  appendToolEventToThread: vi.fn(),
  setThreadMessageThinking: vi.fn(),
  appendRichBlockToThread: vi.fn(),
  setThreadMessageMetadata: mockSetThreadMessageMetadata,
  setThreadMessageUsage: mockSetThreadMessageUsage,
  incrementUnread: vi.fn(),
  clearThreadActiveInvocation: mockClearThreadActiveInvocation,
  resetThreadInvocationState: mockResetThreadInvocationState,
  setThreadMessageStreaming: mockSetThreadMessageStreaming,
  getThreadState: mockGetThreadState,
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

/** The turn's response as the server stores it at dispatch: empty, processing, real id. */
function seedResponse(id: string, catId: string, invocationId: string) {
  storeState.messages.push({
    id,
    type: 'assistant',
    catId,
    content: '',
    origin: 'stream',
    isStreaming: true,
    timestamp: 1000,
    lifecycle: { kind: 'response', invocationId, targetId: catId, status: 'processing', startedAt: 1000 },
  });
}

// ── Test suite ──────────────────────────────────────────────────────────────────

describe('F230 footer-parity: invocation_usage → metadata on the named response (active path)', () => {
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('invocation_usage with model+provider writes metadata on the named response (F230 PTY footer fix)', () => {
    // The response exists WITHOUT metadata: PTY text events carry none
    // (transcriptEntriesToAgentMessages produces no metadata).
    seedResponse('resp-pty-001', 'sonnet', 'inv-pty-001');

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'sonnet',
        messageId: 'resp-pty-001',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'sonnet',
          usage: { inputTokens: 0, outputTokens: 1042, cacheReadTokens: 55932 },
          model: 'claude-sonnet-4-6',
          provider: 'claude_interactive_pty',
        }),
      });
    });

    // F230: metadata must be written with model + provider on the response the event names
    expect(mockSetThreadMessageMetadata).toHaveBeenCalledWith(
      'thread-1',
      'resp-pty-001',
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        provider: 'claude_interactive_pty',
      }),
    );
    // Usage must also be persisted on the message
    expect(mockSetThreadMessageUsage).toHaveBeenCalledWith(
      'thread-1',
      'resp-pty-001',
      expect.objectContaining({ outputTokens: 1042 }),
    );

    // Codex P2: ordering fix — metadata MUST be written BEFORE usage.
    // The usage write is a no-op when metadata is absent (chatStore guard).
    // For PTY path, text events carry no metadata, so invocation_usage is the only source.
    const metaOrder = mockSetThreadMessageMetadata.mock.invocationCallOrder[0];
    const usageOrder = mockSetThreadMessageUsage.mock.invocationCallOrder[0];
    expect(metaOrder).toBeLessThan(usageOrder);
  });

  it('invocation_usage WITHOUT model/provider → metadata NOT written (backward compat)', () => {
    // Older carriers / payloads without model+provider must not write metadata
    // (avoid writing { model: undefined, provider: undefined } which would break MetadataBadge)
    seedResponse('resp-legacy-001', 'opus', 'inv-legacy-001');

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        messageId: 'resp-legacy-001',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'opus',
          usage: { inputTokens: 100, outputTokens: 50 },
          // no model, no provider
        }),
      });
    });

    // metadata must NOT be written — only usage should be
    expect(mockSetThreadMessageMetadata).not.toHaveBeenCalled();
    expect(mockSetMessageMetadata).not.toHaveBeenCalled();
    expect(mockSetThreadMessageUsage).toHaveBeenCalledWith(
      'thread-1',
      'resp-legacy-001',
      expect.objectContaining({ inputTokens: 100 }),
    );
  });

  it('keeps Sol usage internal and writes the footer when cat-level telemetry projection throws', () => {
    seedResponse('resp-sol-usage', 'codex-sol', 'inv-sol-usage');
    mockSetCatInvocation.mockImplementationOnce(() => {
      throw new Error('simulated synchronous cat telemetry projection failure');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    act(() => {
      root.render(React.createElement(Harness));
    });

    try {
      act(() => {
        captured?.handleAgentMessage({
          type: 'system_info',
          catId: 'codex-sol',
          messageId: 'resp-sol-usage',
          content: JSON.stringify({
            type: 'invocation_usage',
            catId: 'codex-sol',
            usage: {
              inputTokens: 126626,
              outputTokens: 2017,
              cacheReadTokens: 125696,
              lastTurnInputTokens: 126626,
              contextUsedTokens: 126626,
            },
            model: 'gpt-5.6-sol',
            provider: 'openai',
          }),
        });
      });
      expect(warnSpy).toHaveBeenCalledWith(
        '[system_info] active internal projection failed; payload suppressed',
        expect.objectContaining({ catId: 'codex-sol' }),
      );
    } finally {
      warnSpy.mockRestore();
    }

    expect(mockSetThreadMessageMetadata).toHaveBeenCalledWith('thread-1', 'resp-sol-usage', {
      model: 'gpt-5.6-sol',
      provider: 'openai',
    });
    expect(mockSetThreadMessageUsage).toHaveBeenCalledWith(
      'thread-1',
      'resp-sol-usage',
      expect.objectContaining({ inputTokens: 126626, outputTokens: 2017, cacheReadTokens: 125696 }),
    );
    expect(mockAddMessage).not.toHaveBeenCalled();
    expect(mockAddMessageToThread).not.toHaveBeenCalled();
  });
});
