import EventEmitter from 'node:events';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { type SocketCallbacks, useSocket } from '../useSocket';

const mockSocket = new EventEmitter() as EventEmitter & {
  connected: boolean;
  id: string;
  io: { engine: { transport: { name: string }; on: () => void } };
  disconnect: () => void;
  emit: (...args: unknown[]) => boolean;
};
mockSocket.connected = true;
mockSocket.id = 'execution-refresh-socket';
mockSocket.io = { engine: { transport: { name: 'websocket' }, on: vi.fn() } };
mockSocket.disconnect = vi.fn();
mockSocket.emit = vi.fn(() => true) as unknown as typeof mockSocket.emit;

vi.mock('socket.io-client', () => ({ io: () => mockSocket }));
vi.mock('@/utils/api-client', () => ({
  refreshApiSession: vi.fn(async () => {}),
  API_URL: 'http://localhost:3100',
  apiFetch: vi.fn(async () => new Response('{}', { status: 200 })),
}));
vi.mock('@/utils/offline-store', () => ({ saveThreadActiveState: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/utils/userId', () => ({ getUserId: () => 'test-user' }));
const refresh = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../useActiveExecutionProjection', async (original) => ({
  ...(await original<typeof import('../useActiveExecutionProjection')>()),
  refreshActiveExecutionProjection: refresh,
}));

let container: HTMLDivElement;
let root: Root;

function Host() {
  const callbacks: SocketCallbacks = { onMessage: vi.fn() };
  useSocket(callbacks, 'thread-open');
  return null;
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  mockSocket.removeAllListeners();
  refresh.mockClear();
  useChatStore.setState({ currentThreadId: 'thread-open', threads: [] });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('rereads the running members when a run starts in a conversation that has no project', () => {
  act(() => root.render(React.createElement(Host)));
  act(() => {
    for (const listener of mockSocket.listeners('spawn_started'))
      (listener as (data: unknown) => void)({
        threadId: 'thread-no-project',
        targetCats: ['opus'],
        invocationId: 'i1',
      });
  });
  expect(refresh).toHaveBeenCalledWith('thread-no-project', null);
});
