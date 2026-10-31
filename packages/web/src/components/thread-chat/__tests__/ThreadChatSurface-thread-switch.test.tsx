import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatData } from '@/hooks/useCatData';
import { useChatStore } from '@/stores/chatStore';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../../shell/shell-presentation';

const knownCat = vi.hoisted(
  () =>
    ({
      id: 'opus',
      displayName: '布偶猫',
      nickname: '宪宪',
      breedId: 'ragdoll',
      avatar: '/avatars/opus.png',
      color: { primary: '#9B7EBD', secondary: '#E8DFF5' },
      mentionPatterns: ['@opus'],
      clientId: 'anthropic',
      defaultModel: 'claude',
    }) as CatData,
);
vi.mock('@/utils/api-client', async (original) => ({
  ...(await original<object>()),
  apiFetch: () => new Promise(() => {}),
}));
vi.mock('@/hooks/useSendMessage', () => ({
  useSendMessage: () => ({ handleSend: vi.fn(), uploadStatus: 'idle', uploadError: null }),
}));
vi.mock('@/hooks/useCatData', async (original) => ({
  ...(await original<object>()),
  useCatData: () => ({
    cats: [knownCat],
    getCatById: (id: string) => (id === 'opus' ? knownCat : undefined),
    refresh: vi.fn(),
  }),
}));
vi.mock('@/hooks/useConnectionStatus', () => ({
  useConnectionStatus: () => ({
    api: 'connected',
    socket: 'connected',
    upstream: 'connected',
    isReadonly: false,
    checkedAt: 0,
    forwardingBlocked: false,
    updateRequired: false,
  }),
}));
vi.mock('../ThreadChatRuntimeProvider', async (original) => ({
  ...(await original<object>()),
  useThreadChatRuntime: () => ({ socketConnected: true }),
}));
vi.mock('../ThreadChatHistoryNavigation', () => ({ ThreadChatHistoryNavigation: () => null }));
vi.mock('../ThreadChatPendingMembers', () => ({ ThreadChatPendingMembers: () => null }));
vi.mock('../ThreadExecutionLayer', () => ({ ThreadExecutionLayer: () => null }));
vi.mock('../../ChatInput', () => ({ ChatInput: () => null }));
vi.mock('../../reply-layers/ReplyRecallRuntimeProvider', () => ({
  ReplyRecallRuntimeProvider: ({ children }: { children: ReactNode }) => children,
}));

import { ThreadChatHistoryAdmissionProvider } from '../ThreadChatRuntimeProvider';
import { ThreadChatSurface } from '../ThreadChatSurface';

const Surface = ({ id }: { id: string }) => (
  <ThreadChatHistoryAdmissionProvider>
    <ThreadChatSurface threadId={id} density="full" />
  </ThreadChatHistoryAdmissionProvider>
);

describe('ThreadChatSurface keeps its scroll container (and the listeners bound to it) across a thread switch', () => {
  let container: HTMLDivElement;
  let root: Root;
  const wheelTargets = new Set<EventTarget>();
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  let previousState: ReturnType<typeof useChatStore.getState>;

  beforeEach(() => {
    Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
    window.localStorage.clear();
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
    wheelTargets.clear();
    previousState = useChatStore.getState();
    vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type,
      listener,
      options,
    ) {
      if (type === 'wheel' && this instanceof Element) wheelTargets.add(this);
      return originalAdd.call(this, type, listener, options);
    });
    vi.spyOn(EventTarget.prototype, 'removeEventListener').mockImplementation(function (
      this: EventTarget,
      type,
      listener,
      options,
    ) {
      if (type === 'wheel') wheelTargets.delete(this);
      return originalRemove.call(this, type, listener, options);
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    useChatStore.setState(previousState, true);
    vi.restoreAllMocks();
    container.remove();
  });

  it('after thread A -> B the live <main> is the same node and still has the wheel listener', async () => {
    await act(async () => {
      useChatStore.setState({ currentThreadId: 'thread-a' });
      root.render(<Surface id="thread-a" />);
    });
    const mainA = container.querySelector('main.overflow-y-auto');
    expect(mainA).not.toBeNull();
    expect(wheelTargets.has(mainA as Element)).toBe(true);
    await act(async () => {
      useChatStore.setState({ currentThreadId: 'thread-b' });
      root.render(<Surface id="thread-b" />);
    });
    const mainB = container.querySelector('main.overflow-y-auto');
    expect(mainB).toBe(mainA);
    expect(mainB?.isConnected).toBe(true);
    expect(wheelTargets.has(mainB as Element)).toBe(true);
  });

  it.each([
    'v2',
    'classic',
  ] as const)('keeps the real history scroll node and wheel listener through a round trip from %s', async (initialShell) => {
    writeShellPresentation(initialShell);
    await act(async () => {
      useChatStore.setState({ currentThreadId: 'thread-a' });
      root.render(<Surface id="thread-a" />);
    });
    const main = container.querySelector('main.overflow-y-auto');
    expect(main).not.toBeNull();
    expect(wheelTargets.has(main as Element)).toBe(true);
    for (const shell of [initialShell === 'v2' ? 'classic' : 'v2', initialShell] as const) {
      await act(async () => writeShellPresentation(shell));
      const current = container.querySelector('main.overflow-y-auto');
      expect(current).toBe(main);
      expect(current?.isConnected).toBe(true);
      expect(wheelTargets.has(current as Element)).toBe(true);
    }
  });
});
