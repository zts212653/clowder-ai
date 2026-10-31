/**
 * F309: the Host receipt a content modification leaves in the conversation travels as a typed `extra` carrier.
 * Cold history hydration and live/history reconciliation must both keep it, or the receipt card cannot be drawn
 * and the reader falls back to the raw stored text with its internal coordinates.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import type { ChatMessage } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { mergeReplaceHydrationMessages, useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

function HookProbe({ threadId }: { threadId: string }) {
  const history = useChatHistory(threadId);
  return React.createElement('div', {
    ref: history.scrollContainerRef,
    style: { height: '100px', overflow: 'auto' },
  });
}

function HookHost({ threadId }: { threadId: string }) {
  return React.createElement(ThreadChatHistoryAdmissionProvider, null, React.createElement(HookProbe, { threadId }));
}

const RECEIPT = {
  v: 1 as const,
  requestId: `f309-modification-${'a'.repeat(64)}`,
  sourceMessageId: 'human-source',
  targetCatId: 'codex-sol',
  taskId: 'task-1',
  state: 'candidate' as const,
  candidateRef: 'candidate-1',
  receiptRef: 'receipt-1',
  observedAt: 1700000000000,
  followUp: { kind: 'none' as const, reason: 'not_applicable' as const },
};

describe('F309 — Host receipt carrier survives hydration and reconciliation', () => {
  const apiFetchMock = vi.mocked(apiFetch);
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
    useChatStore.setState({
      messages: [],
      hasMore: false,
      isLoadingHistory: false,
      currentThreadId: 'thread-target',
      threadStates: {},
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    apiFetchMock.mockReset();
  });

  it('copies extra.contentModificationReceiptV1 and its systemKind into the hydrated system message', async () => {
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            id: 'host-receipt-1',
            type: 'system',
            catId: null,
            content: '[Host 作品修改回执]\nrequestId: …',
            replyTo: 'human-source',
            extra: { systemKind: 'content_modification_receipt', contentModificationReceiptV1: RECEIPT },
            timestamp: 1700000000000,
          },
        ],
        tasks: [],
        hasMore: false,
      }),
    } as Response);

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-target' }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const [message] = useChatStore.getState().messages;
    expect(message.type).toBe('system');
    expect(message.extra?.systemKind).toBe('content_modification_receipt');
    expect(message.extra?.contentModificationReceiptV1).toEqual(RECEIPT);
  });

  it('keeps the carrier when a live copy of the same message is reconciled with history', () => {
    const current: ChatMessage = {
      id: 'host-receipt-1',
      type: 'system',
      content: 'receipt',
      timestamp: 1,
      extra: { systemKind: 'content_modification_receipt' },
    };
    const history: ChatMessage = { ...current, extra: { ...current.extra, contentModificationReceiptV1: RECEIPT } };
    expect(
      mergeReplaceHydrationMessages([history], [current]).messages[0]?.extra?.contentModificationReceiptV1,
    ).toEqual(RECEIPT);
    // And the other way round: history without it must not erase what the live copy already carries.
    expect(
      mergeReplaceHydrationMessages(
        [current],
        [{ ...current, extra: { ...current.extra, contentModificationReceiptV1: RECEIPT } }],
      ).messages[0]?.extra?.contentModificationReceiptV1,
    ).toEqual(RECEIPT);
  });
});
