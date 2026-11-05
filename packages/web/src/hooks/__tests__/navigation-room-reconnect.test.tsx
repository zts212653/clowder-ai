import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { __resetPendingTeleportForTest, peekPendingTeleport } from '@/utils/teleport';
import { useTeleport } from '../useTeleport';
import { type NavigateEvent, useWorkspaceNavigate } from '../useWorkspaceNavigate';
import { getPendingWorkspaceNavigation } from '../workspace-navigation-pending';

Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });

const transport = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  class Socket {
    connected = false;
    rooms = new Set<string>();
    bufferedJoins: string[] = [];
    listeners = new Map<string, Set<Listener>>();
    emit = vi.fn((event: string, room: string) => {
      if (event === 'join_room') {
        if (this.connected) this.rooms.add(room);
        else this.bufferedJoins.push(room);
      }
    });
    on = vi.fn((event: string, listener: Listener) => {
      const entries = this.listeners.get(event) ?? new Set<Listener>();
      entries.add(listener);
      this.listeners.set(event, entries);
      return this;
    });
    off = vi.fn((event: string, listener: Listener) => {
      this.listeners.get(event)?.delete(listener);
      return this;
    });
    disconnect = vi.fn(() => {
      this.connected = false;
      this.rooms.clear();
    });
    connectTransport() {
      // Socket.IO room membership belongs to the server connection, not the hook.
      this.rooms.clear();
      this.connected = true;
      for (const room of this.bufferedJoins.splice(0)) this.rooms.add(room);
      this.announceConnect();
    }
    announceConnect() {
      for (const listener of this.listeners.get('connect') ?? []) listener();
    }
    deliver(room: string, event: string, data: unknown, acknowledge?: Listener) {
      if (!this.connected || !this.rooms.has(room)) return false;
      for (const listener of this.listeners.get(event) ?? []) listener(data, acknowledge);
      return true;
    }
  }
  const sockets: Socket[] = [];
  const factory = {
    sockets,
    connectedOnCreate: false,
    create: vi.fn(() => {
      const socket = new Socket();
      socket.connected = factory.connectedOnCreate;
      sockets.push(socket);
      return socket;
    }),
  };
  return factory;
});

vi.mock('socket.io-client', () => ({ io: () => transport.create() }));

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
  transport.sockets.length = 0;
  transport.connectedOnCreate = false;
  transport.create.mockClear();
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
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  window.sessionStorage.clear();
  __resetPendingTeleportForTest();
});

async function mountedSocket(kind: 'navigate' | 'teleport', options: DeliveryOptions = {}) {
  await act(async () => root.render(kind === 'navigate' ? <NavigateProbe {...options} /> : <TeleportProbe />));
  await vi.waitFor(() => expect(transport.sockets).toHaveLength(1));
  return transport.sockets[0];
}

it.each(['navigate', 'teleport'] as const)('joins an already connected socket for %s', async (kind) => {
  transport.connectedOnCreate = true;
  const socket = await mountedSocket(kind);
  expect(socket.rooms.has(kind === 'navigate' ? 'workspace:navigate:ack' : 'workspace:global')).toBe(true);
});

it('the mounted navigation hook receives a second real delivery after transport reconnect, then detaches', async () => {
  const socket = await mountedSocket('navigate');
  const acknowledge = vi.fn();
  const send = (path: string, eventId: string) => {
    const data: NavigateEvent = { action: 'open', path, worktreeId: 'cat-cafe', threadId: 'thread-current', eventId };
    act(() => socket.deliver('workspace:navigate:ack', 'workspace:navigate', data, acknowledge));
  };
  socket.connectTransport();
  send('docs/before.md', 'before');
  expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/before.md');
  socket.disconnect();
  socket.connectTransport();
  send('docs/after.md', 'after');
  expect(useChatStore.getState().workspaceOpenFilePath).toBe('docs/after.md');
  expect(acknowledge).toHaveBeenLastCalledWith({ status: 'applied', eventId: 'after' });
  socket.announceConnect();
  send('docs/after.md', 'after');
  expect(acknowledge).toHaveBeenCalledTimes(2);
  expect(socket.listeners.get('workspace:navigate')?.size).toBe(1);
  await act(async () => root.unmount());
  expect(socket.listeners.get('connect')?.size ?? 0).toBe(0);
  expect(socket.listeners.get('workspace:navigate')?.size).toBe(0);
});

it('the same Teleport hook navigates after reconnect without remounting or duplicating the event listener', async () => {
  const socket = await mountedSocket('teleport');
  const send = (threadId: string, eventId: string) => {
    act(() => socket.deliver('workspace:global', 'thread:teleport', { threadId, messageId: eventId, eventId }));
  };
  socket.connectTransport();
  send('thread-before', 'message-before');
  expect(window.location.pathname).toBe('/thread/thread-before');
  socket.disconnect();
  socket.connectTransport();
  send('thread-after', 'message-after');
  expect(window.location.pathname).toBe('/thread/thread-after');
  expect(peekPendingTeleport('thread-after')).toEqual({ threadId: 'thread-after', messageId: 'message-after' });
  socket.announceConnect();
  expect(socket.listeners.get('thread:teleport')?.size).toBe(1);
  const pushState = vi.spyOn(window.history, 'pushState');
  send('thread-after', 'message-after');
  expect(pushState).not.toHaveBeenCalled();
  pushState.mockRestore();
  await act(async () => root.unmount());
  expect(socket.listeners.get('connect')?.size ?? 0).toBe(0);
  expect(socket.listeners.get('thread:teleport')?.size).toBe(0);
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
  const socket = await mountedSocket('navigate', options);
  socket.connectTransport();
  socket.disconnect();
  socket.connectTransport();
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
  act(() =>
    socket.deliver(
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
    ),
  );
  expect(acknowledge).toHaveBeenCalledWith({ status, reason, eventId: reason });
  expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
  expect(getPendingWorkspaceNavigation(window.sessionStorage, target)?.path).toBe('docs/queued.md');
});

it('does not create a socket while disabled and disconnects the current subscription when disabled', async () => {
  await act(async () => root.render(<NavigateProbe enabled={false} />));
  expect(transport.create).not.toHaveBeenCalled();
  await act(async () => root.render(<NavigateProbe enabled />));
  const socket = transport.sockets[0];
  socket.connectTransport();
  expect(socket.rooms.has('workspace:navigate:ack')).toBe(true);
  await act(async () => root.render(<NavigateProbe enabled={false} />));
  expect(socket.connected).toBe(false);
  expect(socket.listeners.get('connect')?.size ?? 0).toBe(0);
});
