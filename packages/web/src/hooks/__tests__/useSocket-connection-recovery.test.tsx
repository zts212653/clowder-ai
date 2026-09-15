import { EventEmitter } from 'node:events';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { requestCatchUp, socketHolder } = vi.hoisted(() => ({
  requestCatchUp: vi.fn(),
  socketHolder: { current: null as unknown },
}));

vi.mock('socket.io-client', () => ({ io: () => socketHolder.current }));
vi.mock('@/utils/userId', () => ({ getUserId: () => 'recovery-user' }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3102',
  apiFetch: vi.fn(async () => ({
    ok: true,
    json: async () => ({ queue: [], activeInvocations: [] }),
  })),
}));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({ invalidateSidebarProjection: vi.fn() }));
vi.mock('../useGameReconnect', () => ({ reconnectGame: vi.fn(async () => {}) }));
vi.mock('@/utils/offline-store', () => ({ saveThreadActiveState: vi.fn(async () => {}) }));
vi.mock('@/stores/chatStore', () => {
  const thread = {
    messages: [],
    queue: [],
    activeInvocations: {},
    catInvocations: {},
    catStatuses: {},
    targetCats: [],
    hasActiveInvocation: false,
  };
  const state = {
    ...thread,
    currentThreadId: 'thread-main',
    threadStates: {},
    getThreadState: () => thread,
    requestStreamCatchUp: requestCatchUp,
    setQueue: vi.fn(),
  };
  return {
    useChatStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

import { useSocket } from '../useSocket';

class TestSocket extends EventEmitter {
  id = 'initial-connection';
  connected = true;
  active = true;
  io = { engine: { transport: { name: 'websocket' }, on: vi.fn() } };
  emit = vi.fn((event: string, room: string, acknowledge?: (value: unknown) => void) => {
    if (event === 'join_room') acknowledge?.({ ok: true, room });
    return true;
  });
  connect = vi.fn(() => {
    this.id = 'recovered-connection';
    this.connected = true;
    this.serverEvent('connect');
  });
  disconnect = vi.fn();
  serverEvent(event: string, ...args: unknown[]) {
    return EventEmitter.prototype.emit.call(this, event, ...args);
  }
}

const onMessage = vi.fn();
function Harness({ foreground = ['thread-main'] }: { foreground?: string[] }) {
  useSocket({ onMessage }, 'thread-main', foreground);
  return null;
}

describe('chat connection recovery without a page reload', () => {
  let root: Root;
  let container: HTMLDivElement;
  let socket: TestSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    window.sessionStorage.clear();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    socket = new TestSocket();
    socketHolder.current = socket;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.sessionStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function mount(foreground?: string[]) {
    act(() => {
      root.render(<Harness foreground={foreground} />);
    });
    act(() => socket.serverEvent('connect'));
    requestCatchUp.mockClear();
    socket.emit.mockClear();
  }

  function loseAutomaticRetry() {
    act(() => {
      socket.connected = false;
      socket.serverEvent('disconnect', 'transport close');
    });
    // No later connect event arrives: the connection manager lost its retry.
    // `active` remains true, so application ownership still requests a connection.
  }

  it('recovers a disconnected active socket, rejoins rooms and catches up the missed tail', async () => {
    mount();
    loseAutomaticRetry();

    await act(async () => vi.advanceTimersByTimeAsync(5_000));

    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('join_room', 'thread:thread-main', expect.any(Function));
    expect(requestCatchUp).toHaveBeenCalledWith('thread-main');

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('does not reopen an intentionally disconnected or rejected socket', async () => {
    mount();
    loseAutomaticRetry();
    socket.active = false;

    await act(async () => vi.advanceTimersByTimeAsync(15_000));

    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('retries immediately on returning to the page and catches up every foreground pane', () => {
    mount(['thread-main', 'thread-split']);
    loseAutomaticRetry();

    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(requestCatchUp).toHaveBeenCalledWith('thread-main');
    expect(requestCatchUp).toHaveBeenCalledWith('thread-split');
  });

  it('catches up visible panes even when no reconnect or later message reveals the gap', () => {
    window.sessionStorage.setItem('cat-cafe:ws:joined-rooms:v1:recovery-user', JSON.stringify(['thread:background']));
    mount(['thread-main', 'thread-split']);

    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(socket.connect).not.toHaveBeenCalled();
    expect(requestCatchUp.mock.calls.map(([threadId]) => threadId).sort()).toEqual(['thread-main', 'thread-split']);
  });

  it('does not reload messages merely because the document becomes hidden', () => {
    mount();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });

    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(requestCatchUp).not.toHaveBeenCalled();
  });

  it('stops connection recovery when the owning runtime unmounts', async () => {
    mount();
    loseAutomaticRetry();
    act(() => root.render(null));

    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(socket.connect).not.toHaveBeenCalled();
    expect(requestCatchUp).not.toHaveBeenCalled();
  });
});
