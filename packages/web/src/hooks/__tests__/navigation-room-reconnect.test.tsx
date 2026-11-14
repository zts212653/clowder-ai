import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { createFakeHubSocket, type FakeHubSocket, withHubSocket } from '@/test-utils/fake-hub-socket';
import { __resetPendingTeleportForTest, peekPendingTeleport } from '@/utils/teleport';
import { useTeleport } from '../useTeleport';
import { type NavigateEvent, useWorkspaceNavigate } from '../useWorkspaceNavigate';
import { getPendingWorkspaceNavigation } from '../workspace-navigation-pending';

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

// Room membership and reconnects belong to the page connection (useSocket-hub.test.tsx).
// These hooks hold their room and listener on it; delivery reaches them only while the page
// connection is up and the room is held, as the server delivers by room.
let fake: FakeHubSocket;
function deliver(room: string, event: string, data: unknown, acknowledge?: (...args: unknown[]) => void) {
  if (!fake.hub.connectedSocketId() || !fake.heldRooms().includes(room)) return false;
  fake.deliver(event, data, acknowledge);
  return true;
}

type DeliveryOptions = { threadId?: string; isChatRoute?: boolean; isWorkspaceVisible?: boolean; enabled?: boolean };
function NavigateProbe({ threadId = 'thread-current', ...options }: DeliveryOptions) {
  useWorkspaceNavigate(threadId, { isChatRoute: true, ...options });
  return null;
}
function TeleportProbe() {
  useTeleport();
  return null;
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  fake = createFakeHubSocket();
  window.history.replaceState({}, '', '/thread/thread-current');
  window.sessionStorage.clear();
  __resetPendingTeleportForTest();
  useChatStore.setState({
    currentProjectPath: '/work/cat-cafe',
    currentThreadId: 'thread-current',
    presentationLock: null,
    workspaceWorktreeId: 'cat-cafe',
    workspaceOpenFilePath: null,
    workspaceOpenFileLine: null,
    workspaceOpenTabs: [],
    workspaceWorktreeAliases: {},
    workspaceWorktreeAliasesProjectPath: null,
    rightPanelMode: 'status',
  });
  container = document.createElement('div');
  document.body.append(container);
  root = withHubSocket(createRoot(container), fake.hub);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.sessionStorage.clear();
  __resetPendingTeleportForTest();
});

async function mount(kind: 'navigate' | 'teleport', options: DeliveryOptions = {}) {
  await act(async () => root.render(kind === 'navigate' ? <NavigateProbe {...options} /> : <TeleportProbe />));
}

it.each([
  'navigate',
  'teleport',
] as const)('holds its room on an already connected page connection for %s', async (kind) => {
  fake.connect();
  await mount(kind);
  expect(fake.heldRooms()).toEqual([kind === 'navigate' ? 'workspace:navigate:ack' : 'workspace:global']);
});

it('the mounted navigation hook receives a second real delivery after transport reconnect, then detaches', async () => {
  await mount('navigate');
  const acknowledge = vi.fn();
  const send = (path: string, eventId: string) => {
    const data: NavigateEvent = { action: 'open', path, worktreeId: 'cat-cafe', threadId: 'thread-current', eventId };
    act(() => {
      deliver('workspace:navigate:ack', 'workspace:navigate', data, acknowledge);
    });
  };
  fake.connect();
  send('docs/before.md', 'before');
  expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/before.md');
  fake.disconnect();
  fake.connect();
  send('docs/after.md', 'after');
  expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/after.md');
  expect(acknowledge).toHaveBeenLastCalledWith({ status: 'applied', eventId: 'after' });
  send('docs/after.md', 'after');
  expect(acknowledge).toHaveBeenCalledTimes(2);
  expect(fake.listenerCount('workspace:navigate')).toBe(1);
  await act(async () => root.unmount());
  expect(fake.listenerCount('workspace:navigate')).toBe(0);
  expect(fake.heldRooms()).toEqual([]);
});

it('the same Teleport hook navigates after reconnect without remounting or duplicating the event listener', async () => {
  await mount('teleport');
  const send = (threadId: string, eventId: string) => {
    act(() => {
      deliver('workspace:global', 'thread:teleport', { threadId, messageId: eventId, eventId });
    });
  };
  fake.connect();
  send('thread-before', 'message-before');
  expect(window.location.pathname).toBe('/thread/thread-before');
  fake.disconnect();
  fake.connect();
  send('thread-after', 'message-after');
  expect(window.location.pathname).toBe('/thread/thread-after');
  expect(peekPendingTeleport('thread-after')).toEqual({ threadId: 'thread-after', messageId: 'message-after' });
  expect(fake.listenerCount('thread:teleport')).toBe(1);
  const pushState = vi.spyOn(window.history, 'pushState');
  send('thread-after', 'message-after');
  expect(pushState).not.toHaveBeenCalled();
  pushState.mockRestore();
  await act(async () => root.unmount());
  expect(fake.listenerCount('thread:teleport')).toBe(0);
  expect(fake.heldRooms()).toEqual([]);
});

it.each([
  { reason: 'thread_inactive', options: {}, target: 'thread-other', status: 'queued' },
  { reason: 'non_chat_route', options: { isChatRoute: false }, target: 'thread-current', status: 'queued' },
  { reason: 'narrow_viewport', options: { isWorkspaceVisible: false }, target: 'thread-current', status: 'queued' },
  { reason: 'presentation_lock', options: {}, target: 'thread-current', status: 'blocked' },
])('reconnected delivery preserves $reason instead of claiming applied', async ({
  reason,
  options,
  target,
  status,
}) => {
  await mount('navigate', options);
  fake.connect();
  fake.disconnect();
  fake.connect();
  if (reason === 'presentation_lock') {
    useChatStore.setState({
      presentationLock: {
        ownerThreadId: 'thread-current',
        ownerWorkspace: { worktreeId: 'cat-cafe', filePath: null, line: null, tabs: [] },
        worktreeId: 'cat-cafe',
        filePath: null,
        line: null,
        tabs: [],
        scrollTop: null,
      },
    });
  }
  const acknowledge = vi.fn();
  act(() => {
    deliver(
      'workspace:navigate:ack',
      'workspace:navigate',
      {
        action: 'open',
        path: 'docs/queued.md',
        worktreeId: 'cat-cafe',
        threadId: target,
        eventId: reason,
      },
      acknowledge,
    );
  });
  expect(acknowledge).toHaveBeenCalledWith({ status, reason, eventId: reason });
  expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
  expect(getPendingWorkspaceNavigation(window.sessionStorage, target)?.path).toBe('docs/queued.md');
});

it('holds nothing while disabled and releases its room and listener when disabled again', async () => {
  fake.connect();
  await act(async () => root.render(<NavigateProbe enabled={false} />));
  expect(fake.heldRooms()).toEqual([]);
  expect(fake.listenerCount('workspace:navigate')).toBe(0);
  await act(async () => root.render(<NavigateProbe enabled />));
  expect(fake.heldRooms()).toEqual(['workspace:navigate:ack']);
  await act(async () => root.render(<NavigateProbe enabled={false} />));
  expect(fake.heldRooms()).toEqual([]);
  expect(fake.listenerCount('workspace:navigate')).toBe(0);
  // The page connection itself stays up for the rest of the page.
  expect(fake.hub.connectedSocketId()).not.toBeNull();
});
