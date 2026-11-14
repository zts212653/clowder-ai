import type { LifecycleActiveRun } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSearchOverlay } from '@/components/message-search/MessageSearchOverlay';
import { type MessageSearchHost, useMessageSearchHost } from '@/components/message-search/useMessageSearchHost';
import { ShellPresentationContext } from '@/components/shell/shell-presentation';
import { MessageNavigationProvider } from '@/components/thread-chat/MessageNavigationContext';
import type { ChatReadingPort } from '@/components/thread-chat/useThreadChatReadingPort';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage } from '@/stores/chat-types';
import { apiFetch } from '@/utils/api-client';
import { AppendedInputReceipts } from '../AppendedInputReceipts';
import { MessageDispatchAvatars } from '../MessageDispatchAvatars';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('../CatAvatar', () => ({
  CatAvatar: ({ catId, status, size }: { catId: string; status?: string; size?: number }) => (
    <span data-testid="cat-avatar" data-cat-id={catId} data-status={status} data-size={size} />
  ),
}));

const DISPATCHED_AT = new Date(2026, 10, 10, 18, 0, 0).getTime();

function makeInitialInput(): ChatMessage {
  return {
    id: 'input-0',
    from: { kind: 'user', userId: 'owner' },
    type: 'user',
    content: '初始问题',
    timestamp: 100,
    lifecycle: {
      kind: 'input',
      orderKey: '100:input-0',
      dispatchRefs: [{ targetId: 'codex-astra', phase: 'settled', statusMessageId: 'response-1', dispatchedAt: 101 }],
    },
  };
}

function makeResponse(status: 'processing' | 'completed', inputMessageIds: readonly string[]): ChatMessage {
  return {
    id: 'response-1',
    from: { kind: 'agent', catId: 'codex-astra' },
    type: 'assistant',
    catId: 'codex-astra',
    content: status === 'processing' ? '正在写完整方案…' : '完整方案正文',
    timestamp: 110,
    lifecycle: {
      kind: 'response',
      orderKey: '110:turn-1',
      invocationId: 'turn-1',
      targetId: 'codex-astra',
      inputEntryIds: inputMessageIds.map((_, idx) => `entry-${idx}`),
      inputMessageIds,
      status,
      startedAt: 110,
      ...(status === 'processing' ? {} : { completedAt: 200 }),
    },
  };
}

function makeAppendedInput(phase: 'dispatched' | 'settled'): ChatMessage {
  return {
    id: 'input-appended',
    from: { kind: 'user', userId: 'owner' },
    type: 'user',
    content: '过程中补充一句约束',
    timestamp: 150,
    lifecycle: {
      kind: 'input',
      orderKey: '150:input-appended',
      dispatchRefs: [
        {
          targetId: 'codex-astra',
          phase,
          statusMessageId: 'response-1',
          dispatchedAt: DISPATCHED_AT,
          appendAcceptance: 'accepted',
          appendDelivery: { dispatchStarted: true },
          inputRead: { status: 'read', at: DISPATCHED_AT + 1_000 },
        },
      ],
    },
  };
}

const appendedActiveRun: LifecycleActiveRun = {
  threadId: 'thread-1',
  targetId: 'codex-astra',
  invocationId: 'turn-1',
  responseMessageId: 'response-1',
  inputEntryIds: ['entry-0', 'entry-1'],
  inputMessageIds: ['input-0', 'input-appended'],
  privateInputEntryIds: [],
  startedAt: 110,
};

function makeMockReader(ref = 'chat-reading:thread-1:origin-ref'): ChatReadingPort {
  return {
    threadId: 'thread-1',
    ownerId: 'owner-1',
    captureReadingRef: vi.fn(() => ({ ref, persisted: true })),
    navigateToMessage: vi.fn(async (messageId) => ({
      status: 'settled' as const,
      threadId: 'thread-1',
      messageId,
      position: { anchor: 'offset' as const, top: 40, messageAnchor: { messageId, viewportOffsetPx: 0 } },
    })),
    restoreReadingRef: vi.fn(async () => ({
      status: 'settled' as const,
      exact: true,
      position: { anchor: 'bottom' as const, top: 2400 },
    })),
    releaseReadingRef: vi.fn(() => true),
  };
}

describe('supplement-to-reply jump and return (DESIGN.md §聊天里的顺序)', () => {
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
    localStorage.clear();
    vi.mocked(apiFetch).mockReset();
    primeCoCreatorConfigCache({ name: 'Operator', aliases: [], mentionPatterns: ['@operator'] });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetCoCreatorConfigCacheForTest();
  });

  const renderAvatars = (
    message: ChatMessage,
    timelineMessages: readonly ChatMessage[],
    activeRuns: readonly LifecycleActiveRun[] = [],
  ) => (
    <MessageDispatchAvatars
      message={message}
      timelineMessages={timelineMessages}
      activeRuns={activeRuns}
      getCatLabel={() => 'Astra'}
    />
  );

  const findButton = (label: string) =>
    [...container.querySelectorAll('button')].find((btn) => btn.textContent?.includes(label));

  it('renders ↓ when the reply is below the initial input and ↑ when appended into an earlier-started reply', () => {
    const initial = makeInitialInput();
    const appended = makeAppendedInput('settled');
    const reply = makeResponse('completed', [initial.id, appended.id]);
    const timeline = [initial, reply, appended];

    act(() => {
      root.render(
        <>
          <div data-testid="initial-receipt">{renderAvatars(initial, timeline)}</div>
          <div data-testid="appended-receipt">{renderAvatars(appended, timeline)}</div>
        </>,
      );
    });

    const initialBtn = container.querySelector('[data-testid="initial-receipt"] button');
    const appendedBtn = container.querySelector('[data-testid="appended-receipt"] button');
    expect(initialBtn?.textContent).toContain('看回复 ↓');
    expect(appendedBtn?.textContent).toContain('看回复 ↑');
  });

  it('keeps 看回复 ↑ clickable with loadIfNeeded when the earlier reply is on an unloaded older page', () => {
    const navigate = vi.fn(() => true);
    const activeAppended = makeAppendedInput('dispatched');

    act(() => {
      root.render(
        <MessageNavigationProvider value={navigate}>
          {renderAvatars(activeAppended, [activeAppended], [appendedActiveRun])}
        </MessageNavigationProvider>,
      );
    });

    expect(container.textContent).toContain('收到，并进了正在回的这一轮');
    const activeBtn = container.querySelector('button');
    expect(activeBtn?.textContent).toContain('看回复 ↑');
    act(() => activeBtn?.click());
    expect(navigate).toHaveBeenCalledWith('response-1', { loadIfNeeded: true });

    navigate.mockClear();
    const settledAppended = makeAppendedInput('settled');
    act(() => {
      root.render(
        <MessageNavigationProvider value={navigate}>
          {renderAvatars(settledAppended, [settledAppended])}
        </MessageNavigationProvider>,
      );
    });

    expect(container.textContent).toContain('收到，并进了已结束的这一轮');
    expect(container.textContent).not.toContain('已回复');
    const settledBtn = container.querySelector('button');
    expect(settledBtn?.textContent).toContain('看回复 ↑');
    act(() => settledBtn?.click());
    expect(navigate).toHaveBeenCalledWith('response-1', { loadIfNeeded: true });
  });

  it('does not misclassify non-appended unloaded inputs as appended or show a premature 看回复 ↑ button', () => {
    const unloadedInitialSettled = makeInitialInput();
    act(() => root.render(renderAvatars(unloadedInitialSettled, [unloadedInitialSettled])));
    expect(container.textContent).toContain('收到，回复状态待核对');
    expect(container.textContent).not.toContain('并进了已结束的这一轮');
    expect(container.querySelector('button')).toBeNull();

    const activeInitial: ChatMessage = {
      ...unloadedInitialSettled,
      lifecycle: {
        kind: 'input',
        orderKey: '100:input-0',
        dispatchRefs: [
          { targetId: 'codex-astra', phase: 'dispatched', statusMessageId: 'response-1', dispatchedAt: 101 },
        ],
      },
    };
    act(() => root.render(renderAvatars(activeInitial, [activeInitial], [appendedActiveRun])));
    expect(container.textContent).toContain('收到，正在回…');
    expect(container.textContent).not.toContain('并进了正在回的这一轮');
    expect(container.querySelector('button')).toBeNull();
  });

  it.each([
    'v2',
    'classic',
  ] as const)('shows the shared 回到刚才 top bar in %s shell on causal jump and restores the exact reading origin', async (shell) => {
    let host!: MessageSearchHost;
    const reader = makeMockReader();

    function Harness({ threadId }: { threadId: string }) {
      host = useMessageSearchHost({
        threadId,
        pushThreadRoute: vi.fn(),
        available: true,
        searchAvailable: shell === 'v2',
      });
      return <MessageSearchOverlay threadId={threadId} host={host} available />;
    }

    const renderShell = (shellThreadId: string) =>
      act(() => {
        root.render(
          <ShellPresentationContext.Provider value={shell}>
            <Harness threadId={shellThreadId} />
          </ShellPresentationContext.Provider>,
        );
      });

    renderShell('thread-1');
    act(() => {
      host.registerReadingPort(reader);
    });

    await act(async () => {
      expect(host.jumpInThread('response-1', { refresh: false })).toBe(true);
    });

    expect(apiFetch).not.toHaveBeenCalled();
    expect(reader.captureReadingRef).toHaveBeenCalledOnce();
    expect(reader.navigateToMessage).toHaveBeenCalledWith('response-1', expect.any(AbortSignal), undefined);

    expect(findButton('回到刚才')).toBeTruthy();
    expect(container.textContent).not.toContain('仅计本次返回的结果');
    expect(container.querySelector('button[aria-label="上一处结果"]')).toBeNull();

    renderShell('thread-2');
    expect(container.querySelector('button')).toBeNull();

    renderShell('thread-1');
    act(() => host.registerReadingPort(reader));
    expect(findButton('回到刚才')).toBeTruthy();

    await act(async () => findButton('回到刚才')?.click());
    expect(reader.restoreReadingRef).toHaveBeenCalledWith(
      'chat-reading:thread-1:origin-ref',
      expect.any(AbortSignal),
      undefined,
    );
    expect(reader.releaseReadingRef).toHaveBeenCalledWith('chat-reading:thread-1:origin-ref');
    expect(container.querySelector('button')).toBeNull();
  });

  it('connects unloaded 看回复 ↑ (refresh: true) and bottom receipt 跳到原文 to 回到刚才', async () => {
    let host!: MessageSearchHost;
    const reader = makeMockReader('chat-reading:thread-1:ref');
    const initial = makeInitialInput();
    const appended = makeAppendedInput('settled');
    const reply = makeResponse('completed', [initial.id, appended.id]);

    function SurfaceGate({ messages }: { messages: readonly ChatMessage[] }) {
      host = useMessageSearchHost({ threadId: 'thread-1', pushThreadRoute: vi.fn(), available: true });
      const navigate = (id: string, opts?: { loadIfNeeded?: boolean }) => {
        const loaded = messages.some((m) => m.id === id);
        if (!loaded && !opts?.loadIfNeeded) return false;
        return host.jumpInThread(id, { refresh: Boolean(opts?.loadIfNeeded && !loaded) });
      };
      return (
        <MessageNavigationProvider value={navigate}>
          <MessageSearchOverlay threadId="thread-1" host={host} available />
          {renderAvatars(appended, messages)}
          {messages.some((m) => m.id === reply.id) ? (
            <AppendedInputReceipts response={reply} timelineMessages={messages} getCatById={() => undefined} />
          ) : null}
        </MessageNavigationProvider>
      );
    }

    act(() => root.render(<SurfaceGate messages={[appended]} />));
    act(() => {
      host.registerReadingPort(reader);
    });
    await act(async () => {
      (findButton('看回复 ↑') as HTMLButtonElement).click();
    });
    expect(reader.navigateToMessage).toHaveBeenCalledWith('response-1', expect.any(AbortSignal), { refresh: true });
    expect(findButton('回到刚才')).toBeTruthy();

    act(() => root.render(<SurfaceGate messages={[initial, reply, appended]} />));
    await act(async () => {
      (findButton('跳到原文') as HTMLButtonElement).click();
    });
    expect(reader.navigateToMessage).toHaveBeenLastCalledWith('input-appended', expect.any(AbortSignal), undefined);
    expect(findButton('回到刚才')).toBeTruthy();
  });
});
