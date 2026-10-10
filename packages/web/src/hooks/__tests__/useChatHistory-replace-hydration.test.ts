import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import type { ThreadState } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

function HookProbe({ threadId }: { threadId: string }) {
  useChatHistory(threadId);
  return null;
}

function HookHost({ threadId }: { threadId: string }) {
  return React.createElement(ThreadChatHistoryAdmissionProvider, null, React.createElement(HookProbe, { threadId }));
}

function makeThreadBState(cachedAssistantTs: number, overrides?: Partial<ThreadState>): ThreadState {
  return {
    ...buildThreadBState(cachedAssistantTs),
    ...overrides,
  };
}

function buildThreadBState(cachedAssistantTs: number): ThreadState {
  return {
    messages: [
      {
        id: 'b1',
        type: 'assistant' as const,
        catId: 'opus',
        content: 'cached assistant',
        timestamp: cachedAssistantTs,
      },
    ],
    isLoading: true,
    isLoadingHistory: false,
    hasMore: true,
    hasActiveInvocation: true,
    activeInvocations: {},
    intentMode: 'execute' as const,
    targetCats: ['opus'],
    catStatuses: { opus: 'streaming' as const },
    catStatusDetails: {},
    catInvocations: {},
    currentGame: null,

    unreadCount: 0,
    hasUserMention: false,
    lastActivity: cachedAssistantTs,
    queue: [],
    queueFull: false,
    queueFullSource: undefined,
    workspaceWorktreeId: null,
    workspaceOpenTabs: [],
    workspaceOpenFilePath: null,
    workspaceOpenFileLine: null,
  };
}

describe('useChatHistory replace hydration', () => {
  let container: HTMLDivElement;
  let root: Root;
  let revokeSpy: ReturnType<typeof vi.spyOn>;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    if (!globalThis.URL.revokeObjectURL) {
      Object.defineProperty(globalThis.URL, 'revokeObjectURL', {
        writable: true,
        value: vi.fn(),
      });
    }
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

    useChatStore.setState({
      messages: [{ id: 'a1', type: 'user', content: 'thread-a message', timestamp: Date.now() - 2000 }],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,

      threadStates: {},
      currentThreadId: 'thread-a',
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    revokeSpy.mockRestore();
    apiFetchMock.mockReset();
  });

  function mountReplaceHydrationThread(threadState: ThreadState) {
    useChatStore.setState({
      messages: [{ id: 'a1', type: 'user', content: 'thread-a message', timestamp: Date.now() - 2000 }],
      currentThreadId: 'thread-a',
      threadStates: { 'thread-b': threadState },
    });

    act(() => {
      root.render(React.createElement(HookHost, { threadId: 'thread-b' }));
    });

    act(() => {
      useChatStore.getState().setCurrentThread('thread-b');
    });
  }

  function installDeferredHistoryResponse() {
    let resolveJson: ((value: unknown) => void) | null = null;
    apiFetchMock.mockResolvedValue({
      ok: true,
      json: () =>
        new Promise((resolve) => {
          resolveJson = resolve;
        }),
    } as Response);
    return {
      waitUntilPending: async () => {
        await act(async () => {
          await Promise.resolve();
        });
      },
      resolve: async (payload: unknown) => {
        await act(async () => {
          resolveJson?.(payload);
          await Promise.resolve();
        });
      },
      expectPending: () => expect(resolveJson).not.toBeNull(),
    };
  }

  it('rehydrates the saved companion identity instead of replacing it with current selection', async () => {
    const history = installDeferredHistoryResponse();
    mountReplaceHydrationThread(makeThreadBState(Date.now() - 1000));
    await history.waitUntilPending();
    const identity = {
      v: 1,
      name: '猫猫球',
      partner: { catId: 'fable-5', displayName: '宪宪', skin: 'xianxian-codex' },
      live: { catId: 'codex6-sol', displayName: '砚砚', transport: 'gpt_live_v3', verifiedModel: null },
      deep: { catId: 'fable-5', displayName: '宪宪', verifiedModel: null },
    };
    await history.resolve({
      messages: [
        {
          id: 'saved-live',
          type: 'assistant',
          catId: 'codex6-sol',
          content: '那天的回答',
          timestamp: Date.now(),
          extra: { liveCompanion: { modality: 'voice', identity } },
        },
      ],
      tasks: [],
      hasMore: false,
    });
    expect(
      useChatStore.getState().messages.find((message) => message.id === 'saved-live')?.extra?.liveCompanion?.identity,
    ).toEqual(identity);
  });

  it('hydrates semantic messages through the shared projector without exposing stored raw copy', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1000;
    mountReplaceHydrationThread(makeThreadBState(cachedAssistantTs));
    await history.waitUntilPending();

    await history.resolve({
      messages: [
        {
          id: 'semantic-history-1',
          type: 'system',
          catId: 'system',
          content: '{"method":"raw/provider/warning"}',
          timestamp: 1_788_000_000_000,
          extra: {
            semanticEvent: {
              v: 1,
              id: 'semantic-history-event-1',
              kind: 'warning',
              occurredAt: 1_788_000_000_000,
              category: 'safety',
              severity: 'warning',
              message: '受保护操作已拒绝。',
              provenance: { provider: 'codex', carrier: 'app_server' },
            },
          },
        },
      ],
      hasMore: false,
    });

    const hydrated = useChatStore.getState().messages.find((message) => message.id === 'semantic-history-1');
    expect(hydrated?.type).toBe('system');
    expect(hydrated?.content).toBe('警告：受保护操作已拒绝。');
    expect(JSON.stringify(hydrated)).not.toContain('raw/provider');
  });

  it('cold hydration keeps the exact cloud retry and pending custody source, but drops retired Queue receipts', async () => {
    const history = installDeferredHistoryResponse();
    const retry = {
      v: 1,
      sourceMessageId: 'failed-source',
      targetCatId: 'gpt-pro',
      priorDispatchInvocationId: 'failed-dispatch',
    };
    const offer = {
      offerId: 'custody-offer:retry-source',
      sourceMessageRevision: `sha256:${'a'.repeat(64)}`,
      policyVersion: 'custody-recognition-v1',
      reasonCode: 'future_deliverable',
      disposition: 'pending',
    };
    mountReplaceHydrationThread(makeThreadBState(Date.now() - 1000));
    await history.waitUntilPending();
    await history.resolve({
      messages: [
        {
          id: 'retry-source',
          type: 'user',
          content: '继续这个委托',
          timestamp: Date.now(),
          extra: { cloudBridgeRetry: retry, custodyOfferV1: offer, queueReceipt: { status: 'queued' } },
        },
      ],
      hasMore: false,
    });
    const hydrated = useChatStore.getState().messages.find((message) => message.id === 'retry-source');
    expect(hydrated?.extra?.cloudBridgeRetry).toEqual(retry);
    expect(hydrated?.extra?.custodyOfferV1).toEqual(offer);
    expect(hydrated?.extra).not.toHaveProperty('queueReceipt');
  });

  it('hydrates a modification source from persisted history when no live metadata copy exists', async () => {
    const history = installDeferredHistoryResponse();
    const metadata = {
      v: 1,
      requestId: 'f309-modification-' + 'a'.repeat(64),
      requestFingerprint: 'sha256:' + 'b'.repeat(64),
      contentTitle: '晨光封面',
      targetCatId: 'codex-astra',
      targetName: '小星星',
      executionThreadTitle: '封面共创',
      completionRule: 'file-writeback-applied',
    };
    mountReplaceHydrationThread(makeThreadBState(Date.now() - 1000));
    await history.waitUntilPending();
    await history.resolve({
      messages: [
        {
          id: 'modification-source',
          catId: null,
          content: '移除画面标志',
          timestamp: Date.now(),
          extra: { contentModificationRequestV1: metadata },
        },
      ],
      hasMore: false,
    });
    expect(
      useChatStore.getState().messages.find((item) => item.id === 'modification-source')?.extra
        ?.contentModificationRequestV1,
    ).toEqual(metadata);
  });

  it('preserves the source-owned custody offer when a stale hydration copy omits message extra', async () => {
    const history = installDeferredHistoryResponse();
    const timestamp = Date.now() - 1_000;
    const sourceMessageRevision = `sha256:${'a'.repeat(64)}`;
    mountReplaceHydrationThread(
      makeThreadBState(timestamp, {
        messages: [
          {
            id: 'custody-source-1',
            type: 'user',
            content: '下周把演示稿整理好',
            timestamp,
            extra: {
              custodyOfferV1: {
                offerId: 'custody-offer:custody-source-1',
                sourceMessageRevision,
                policyVersion: 'custody-recognition-v1',
                reasonCode: 'future_deliverable',
                disposition: 'pending',
              },
            },
          },
        ],
      }),
    );
    await history.waitUntilPending();

    await history.resolve({
      messages: [
        {
          id: 'custody-source-1',
          type: 'user',
          content: '下周把演示稿整理好',
          timestamp,
        },
      ],
      hasMore: false,
    });

    expect(useChatStore.getState().messages[0]?.extra?.custodyOfferV1).toEqual(
      expect.objectContaining({
        offerId: 'custody-offer:custody-source-1',
        sourceMessageRevision,
        disposition: 'pending',
      }),
    );
  });

  it('suppresses entity and invalid semantic records instead of hydrating empty timeline bubbles', async () => {
    const history = installDeferredHistoryResponse();
    mountReplaceHydrationThread(makeThreadBState(Date.now() - 1000));
    await history.waitUntilPending();

    await history.resolve({
      messages: [
        {
          id: 'semantic-entity-goal',
          type: 'system',
          catId: 'system',
          content: 'raw goal copy',
          timestamp: 100,
          extra: {
            semanticEvent: {
              v: 1,
              id: 'goal-history-1',
              kind: 'goal',
              occurredAt: 100,
              state: 'updated',
              revision: 1,
              objective: 'Ship',
              source: 'codex_app_server',
              observedAt: 100,
            },
          },
        },
        {
          id: 'semantic-workspace-plan',
          type: 'system',
          catId: 'system',
          content: 'raw plan copy',
          timestamp: 101,
          extra: {
            semanticEvent: {
              v: 1,
              id: 'plan-history-1',
              kind: 'plan',
              occurredAt: 101,
              stage: 'updated',
              text: 'Locate the contract, then fix it.',
            },
          },
        },
        {
          id: 'semantic-invalid-wire',
          type: 'system',
          catId: 'system',
          content: '{"method":"provider/raw"}',
          timestamp: 102,
          extra: { semanticEvent: { method: 'provider/raw' } },
        },
      ],
      hasMore: false,
    });

    const ids = useChatStore.getState().messages.map((message) => message.id);
    expect(ids).not.toContain('semantic-entity-goal');
    expect(ids).toContain('semantic-workspace-plan');
    expect(useChatStore.getState().messages.find((message) => message.id === 'semantic-workspace-plan')).toMatchObject({
      type: 'system',
      content: 'Locate the contract, then fix it.',
    });
    expect(ids).not.toContain('semantic-invalid-wire');
  });

  it('preserves a newer live bubble that arrived after thread switch', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1000;
    mountReplaceHydrationThread(makeThreadBState(cachedAssistantTs));

    act(() => {
      useChatStore.getState().addMessage({
        id: 'live-1',
        type: 'assistant',
        catId: 'opus',
        content: 'live bubble arrived after switch',
        timestamp: Date.now(),
        isStreaming: true,
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['b1', 'live-1']);
    history.expectPending();

    await history.resolve({
      messages: [{ id: 'b1', catId: 'opus', content: 'cached assistant', timestamp: cachedAssistantTs }],
      hasMore: false,
    });

    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['b1', 'live-1']);
  });

  it('preserves server timeline order when a published seed is delivered later', async () => {
    const history = installDeferredHistoryResponse();
    const seedPublishedAt = Date.now() - 4_000;
    const replyPublishedAt = seedPublishedAt + 1_000;
    mountReplaceHydrationThread(makeThreadBState(seedPublishedAt));

    await history.waitUntilPending();
    history.expectPending();

    await history.resolve({
      messages: [
        {
          id: 'b1',
          catId: 'codex-sol',
          content: 'source-cat seed',
          timestamp: seedPublishedAt,
          deliveredAt: seedPublishedAt + 3_000,
          timelineOrderAt: seedPublishedAt,
        },
        {
          id: 'reply-1',
          catId: 'opus',
          content: 'reply after seed',
          timestamp: replyPublishedAt,
        },
      ],
      hasMore: false,
    });

    expect(useChatStore.getState().messages.map((message) => message.id)).toEqual(['b1', 'reply-1']);
    expect(useChatStore.getState().messages[0]).toEqual(
      expect.objectContaining({
        deliveredAt: seedPublishedAt + 3_000,
        timelineOrderAt: seedPublishedAt,
      }),
    );
  });

  it('preserves local CLI payload when hydration returns the same callback id without tool metadata', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1_000;
    const now = Date.now();
    mountReplaceHydrationThread({
      messages: [
        {
          id: 'server-callback-tools-1',
          type: 'assistant',
          catId: 'opus',
          content: 'final callback answer',
          origin: 'callback',
          timestamp: now - 2_000,
          isStreaming: false,
          thinking: 'local thinking that should not disappear',
          toolEvents: [{ id: 'te-local-1', type: 'tool_use', label: 'Read file', timestamp: now - 1_800 }],
          extra: { stream: { invocationId: 'inv-tools-1' } },
        },
      ],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      activeInvocations: {},
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catStatusDetails: {},
      catInvocations: {},
      currentGame: null,
      unreadCount: 1,
      hasUserMention: false,
      lastActivity: cachedAssistantTs,
      queue: [],
      queueFull: false,
      queueFullSource: undefined,
      workspaceWorktreeId: null,
      workspaceOpenTabs: [],
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
    });

    await history.waitUntilPending();
    history.expectPending();

    await history.resolve({
      messages: [
        {
          id: 'server-callback-tools-1',
          catId: 'opus',
          content: 'final callback answer',
          origin: 'callback',
          timestamp: now,
        },
      ],
      hasMore: false,
    });

    expect(useChatStore.getState().messages).toEqual([
      expect.objectContaining({
        id: 'server-callback-tools-1',
        origin: 'callback',
        content: 'final callback answer',
        thinking: 'local thinking that should not disappear',
        extra: { stream: { invocationId: 'inv-tools-1' } },
        toolEvents: [expect.objectContaining({ id: 'te-local-1', type: 'tool_use', label: 'Read file' })],
      }),
    ]);
  });

  it('preserves local blob URLs when a kept stream bubble survives replace hydration', async () => {
    const history = installDeferredHistoryResponse();
    const cachedAssistantTs = Date.now() - 1000;
    const blobUrl = 'blob:live-image-1';
    mountReplaceHydrationThread(makeThreadBState(cachedAssistantTs));

    act(() => {
      useChatStore.getState().addMessage({
        id: 'live-blob',
        type: 'assistant',
        catId: 'opus',
        content: 'local image bubble',
        contentBlocks: [{ type: 'image', url: blobUrl }],
        timestamp: Date.now(),
        isStreaming: true,
        origin: 'stream',
      });
    });

    await history.waitUntilPending();
    history.expectPending();

    await history.resolve({
      messages: [{ id: 'b1', catId: 'opus', content: 'cached assistant', timestamp: cachedAssistantTs }],
      hasMore: false,
    });

    expect(revokeSpy).not.toHaveBeenCalledWith(blobUrl);
    expect(useChatStore.getState().messages.find((m) => m.id === 'live-blob')?.contentBlocks).toEqual([
      { type: 'image', url: blobUrl },
    ]);
  });
});
