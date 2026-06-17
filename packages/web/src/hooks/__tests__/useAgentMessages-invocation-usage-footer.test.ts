/**
 * F230 footer-parity: invocation_usage with model/provider populates bubble metadata.
 *
 * PTY carrier produces text events WITHOUT metadata (transcriptEntriesToAgentMessages).
 * The active-path invocation_usage handler must write model/provider via setMessageMetadata
 * so the MetadataBadge footer ("claude-sonnet-4-6 · claude_interactive_pty") renders.
 *
 * Coverage:
 *   - Active path: invocation_usage with model/provider → setMessageMetadata called
 *   - Active path: invocation_usage without model/provider → setMessageMetadata NOT called (backward compat)
 *
 * Design: seed the ThreadRuntimeLedger directly so getActive() returns a known message ID
 * without needing to replay the full text-event flow.
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveBubble } from '@/hooks/thread-runtime-ledger';
import { getThreadRuntimeLedger, resetThreadRuntimeSingleton } from '@/hooks/thread-runtime-singleton';
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

const mockAddMessageToThread = vi.fn();
const mockClearThreadActiveInvocation = vi.fn();
const mockResetThreadInvocationState = vi.fn();
const mockSetThreadMessageStreaming = vi.fn();
const mockGetThreadState = vi.fn(() => ({ messages: [] }));

const storeState = {
  messages: [],
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
  return { useChatStore: useChatStoreMock };
});

function Harness() {
  captured = useAgentMessages();
  return null;
}

// ── Test suite ──────────────────────────────────────────────────────────────────

describe('F230 footer-parity: invocation_usage → setMessageMetadata (active path)', () => {
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
    resetThreadRuntimeSingleton();
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('invocation_usage with model+provider calls setMessageMetadata on active ref (F230 PTY footer fix)', () => {
    // Seed the ledger so getActive('sonnet') returns our message ID.
    // This mimics the state after a PTY text event has established the active bubble
    // but WITHOUT metadata (transcriptEntriesToAgentMessages produces no metadata).
    setActiveBubble(getThreadRuntimeLedger(), 'thread-1', 'sonnet', {
      messageId: 'msg-pty-001',
      invocationId: 'inv-pty-001',
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'sonnet',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'sonnet',
          usage: { inputTokens: 0, outputTokens: 1042, cacheReadTokens: 55932 },
          model: 'claude-sonnet-4-6',
          provider: 'claude_interactive_pty',
        }),
      });
    });

    // F230: setMessageMetadata must be called with model + provider
    expect(mockSetMessageMetadata).toHaveBeenCalledWith(
      'msg-pty-001',
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        provider: 'claude_interactive_pty',
      }),
    );
    // Usage must also be persisted on the message
    expect(mockSetMessageUsage).toHaveBeenCalledWith('msg-pty-001', expect.objectContaining({ outputTokens: 1042 }));

    // Codex P2: ordering fix — setMessageMetadata MUST be called BEFORE setMessageUsage.
    // setMessageUsage is a no-op when metadata is absent (chatStore guard).
    // For PTY path, text events carry no metadata, so invocation_usage is the only source.
    const metaOrder = mockSetMessageMetadata.mock.invocationCallOrder[0];
    const usageOrder = mockSetMessageUsage.mock.invocationCallOrder[0];
    expect(metaOrder).toBeLessThan(usageOrder);
  });

  it('invocation_usage WITHOUT model/provider → setMessageMetadata NOT called (backward compat)', () => {
    // Older carriers / payloads without model+provider must not call setMessageMetadata
    // (avoid writing { model: undefined, provider: undefined } which would break MetadataBadge)
    setActiveBubble(getThreadRuntimeLedger(), 'thread-1', 'opus', {
      messageId: 'msg-legacy-001',
      invocationId: 'inv-legacy-001',
    });

    act(() => {
      root.render(React.createElement(Harness));
    });

    act(() => {
      captured?.handleAgentMessage({
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({
          type: 'invocation_usage',
          catId: 'opus',
          usage: { inputTokens: 100, outputTokens: 50 },
          // no model, no provider
        }),
      });
    });

    // setMessageMetadata must NOT be called — only usage should be written
    expect(mockSetMessageMetadata).not.toHaveBeenCalled();
    expect(mockSetMessageUsage).toHaveBeenCalledWith('msg-legacy-001', expect.objectContaining({ inputTokens: 100 }));
  });
});
