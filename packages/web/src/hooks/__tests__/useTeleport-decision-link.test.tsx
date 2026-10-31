import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { __resetPendingTeleportForTest, peekPendingTeleport } from '@/utils/teleport';
import { useTeleport } from '../useTeleport';
import { useWorkspaceNavigate } from '../useWorkspaceNavigate';

vi.mock('socket.io-client', () => ({
  io: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn(), disconnect: vi.fn() }),
}));
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
  window.sessionStorage.clear();
  __resetPendingTeleportForTest();
});

function CompanionContent() {
  useTeleport();
  return null;
}

function CompanionShell() {
  // Mirror AppShell's reveal consumer above ChatContainer's teleport intake.
  useWorkspaceNavigate('thread-owner', { isChatRoute: true, isWorkspaceVisible: true, enabled: true });
  return <CompanionContent />;
}

it.each([
  'thread-owner',
  'default',
  'thread-other',
])('a browser page remembering %s reveals the exact approval without a socket event', async (rememberedThread) => {
  window.history.replaceState({}, '', '/thread/thread-owner?message=message-source&block=approval-card');
  useChatStore.setState({ currentThreadId: rememberedThread });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<CompanionShell />));
    expect(peekPendingTeleport('thread-owner')).toEqual({ threadId: 'thread-owner', messageId: 'message-source' });
    expect(window.location.search).toBe('');
    // The message arrives after page bootstrap / the authoritative history fetch.
    await act(async () => useChatStore.setState({ currentThreadId: 'thread-owner' }));
    const message = document.createElement('div');
    message.dataset.messageId = 'message-source';
    const card = document.createElement('button');
    card.dataset.richBlockId = 'approval-card';
    message.append(card);
    await act(async () => container.append(message));
    await vi.waitFor(() => expect(document.activeElement).toBe(card));
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each([
  '/thread/thread-owner?message=one&message=two',
  '/thread/thread-owner?block=card',
  '/thread/thread-owner?message=source&block=../card',
  '/thread/thread-owner?message=source&block=one&block=two',
  '/thread/thread-owner?message=source&approve=1',
  '/thread/thread-owner?message=source#foreign',
])('ignores malformed native source links: %s', async (href) => {
  window.history.replaceState({}, '', href);
  useChatStore.setState({ currentThreadId: 'thread-owner' });
  const container = document.createElement('div');
  const root = createRoot(container);
  function Probe() {
    useTeleport();
    return null;
  }
  try {
    await act(async () => root.render(<Probe />));
    expect(peekPendingTeleport('thread-owner')).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
