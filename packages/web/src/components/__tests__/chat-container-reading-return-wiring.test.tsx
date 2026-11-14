import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { primeCoCreatorConfigCache, resetCoCreatorConfigCacheForTest } from '@/hooks/useCoCreatorConfig';
import type { ChatMessage } from '@/stores/chat-types';
import { MessageDispatchAvatars } from '../MessageDispatchAvatars';
import { writeShellPresentation } from '../shell/shell-presentation';
import {
  chatHistoryReadingMocks,
  renderChatContainer,
  resetChatContainerMocks,
  storeState,
} from './chat-container-test-helpers';

vi.mock('@/components/thread-chat/hub-socket-context', () => import('@/test-utils/hub-socket-context-mock'));
vi.mock('../execution-row/ExecutionRow', () => ({ ExecutionRow: () => null }));
vi.mock('../CatAvatar', () => ({ CatAvatar: () => <span data-testid="cat-avatar" /> }));
vi.mock('../ChatMessageRow', () => ({
  ChatMessageRow: ({
    message,
    timelineMessages,
    activeRuns,
  }: {
    message: ChatMessage;
    timelineMessages: readonly ChatMessage[];
    activeRuns?: readonly never[];
  }) => (
    <div data-testid={`row-${message.id}`}>
      <MessageDispatchAvatars
        message={message}
        timelineMessages={timelineMessages}
        activeRuns={activeRuns ?? []}
        getCatLabel={() => 'Astra'}
      />
    </div>
  ),
}));

const unloadedAppendedMessage: ChatMessage = {
  id: 'input-appended',
  from: { kind: 'user', userId: 'owner' },
  type: 'user',
  content: '补充说明一句上下文',
  timestamp: 150,
  lifecycle: {
    kind: 'input',
    orderKey: '150:input-appended',
    dispatchRefs: [
      {
        targetId: 'codex-astra',
        phase: 'settled',
        statusMessageId: 'response-1',
        dispatchedAt: 151,
        appendAcceptance: 'accepted',
        inputRead: { status: 'read', at: 152 },
      },
    ],
  },
};

describe('ChatContainer -> ThreadChatSurface -> MessageSearchOverlay reading return wiring', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    primeCoCreatorConfigCache({ name: 'Operator', aliases: [], mentionPatterns: ['@operator'] });
    resetChatContainerMocks();
    Object.assign(storeState, {
      currentThreadId: 'thread-a',
      messages: [unloadedAppendedMessage],
      getThreadState: () => ({ messages: storeState.messages }),
    });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellPresentation('classic');
    resetCoCreatorConfigCacheForTest();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it.each([
    'v2',
    'classic',
  ] as const)('wires unloaded 看回复 ↑ through ChatContainer and restores reading origin via 回到刚才 in %s shell', async (shell) => {
    writeShellPresentation(shell);
    await act(async () => {
      root.render(renderChatContainer('thread-a'));
    });

    const jumpBtn = [...host.querySelectorAll('button')].find((btn) => btn.textContent?.includes('看回复 ↑'));
    expect(jumpBtn).toBeTruthy();

    await act(async () => {
      jumpBtn?.click();
    });

    expect(chatHistoryReadingMocks.captureReadingRef).toHaveBeenCalledOnce();
    expect(chatHistoryReadingMocks.navigateToMessage).toHaveBeenCalledWith('response-1', expect.any(AbortSignal), {
      refresh: true,
    });

    const returnBtn = [...host.querySelectorAll('button')].find((btn) => btn.textContent?.trim() === '回到刚才');
    expect(returnBtn).toBeTruthy();
    expect(host.querySelector('button[aria-label="上一处结果"]')).toBeNull();

    await act(async () => {
      returnBtn?.click();
    });

    expect(chatHistoryReadingMocks.restoreReadingRef).toHaveBeenCalledWith(
      'chat-reading:thread-a:origin-ref',
      expect.any(AbortSignal),
      undefined,
    );
    expect(chatHistoryReadingMocks.releaseReadingRef).toHaveBeenCalledWith('chat-reading:thread-a:origin-ref');
    expect([...host.querySelectorAll('button')].find((btn) => btn.textContent?.trim() === '回到刚才')).toBeUndefined();
  });
});
