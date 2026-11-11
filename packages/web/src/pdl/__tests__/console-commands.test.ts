import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { HubSocket } from '@/hooks/useSocket-hub';
import { apiFetch } from '@/utils/api-client';
import { useConsoleCommandBindings } from '../useConsoleCommandBindings';
import { act, cleanup, renderHook } from './hook-host';

const wire = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: unknown[]) => unknown>>();
  const server = (name: string, ...args: unknown[]) => {
    handlers.get(name)?.forEach((fn) => fn(...args));
  };
  const socket = {
    id: 'command-socket',
    connected: false,
    emit: vi.fn(),
    on(name: string, fn: (...args: unknown[]) => unknown) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
      return socket;
    },
    off(name: string, fn: (...args: unknown[]) => unknown) {
      handlers.get(name)?.delete(fn);
      return socket;
    },
    connect: vi.fn(() => {
      socket.connected = true;
      server('connect');
    }),
    disconnect: vi.fn(() => {
      socket.connected = false;
    }),
  };
  return { socket, server, handlers };
});
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
const hub: HubSocket = {
  on(event, listener) {
    const handler = listener as (...args: unknown[]) => void;
    wire.socket.on(event, handler);
    return () => {
      wire.socket.off(event, handler);
    };
  },
  emit: (event, ...args) => {
    wire.socket.emit(event, ...args);
    return true;
  },
  retainRoom: (room) => {
    wire.socket.emit('join_room', room);
    return () => wire.socket.emit('leave_room', room);
  },
  onConnected: (listener) => {
    listener(wire.socket.id);
    return () => {};
  },
  connectedSocketId: () => wire.socket.id,
};
const observed = {
  route: '/thread/current',
  threadId: 'current',
  composer: false,
  sections: [{ id: 'members', label: 'Members' }],
};
const clientToken = '11111111-1111-4111-8111-111111111111';
const token = '22222222-2222-4222-8222-222222222222';
let clientId: string;
let emit: ReturnType<typeof vi.fn>;
beforeEach(() => {
  wire.handlers.clear();
  wire.socket.connected = false;
  vi.clearAllMocks();
  emit = vi.fn((event: string) => (event === 'home:inspect' ? observed : true));
  window.clowderChat = { emit, dataOk: vi.fn(), dataError: vi.fn() } as unknown as typeof window.clowderChat;
  vi.mocked(apiFetch).mockImplementation(async (path, init) => {
    if (path === '/api/concierge/home/clients') {
      clientId = JSON.parse(String(init!.body)).clientId;
      return Response.json({ clientToken, expiresAt: Date.now() + 60_000 });
    }
    if (String(path).includes('/commands/'))
      return Response.json({
        clientId,
        baseRoute: observed.route,
        expiresAt: Date.now() + 5000,
        kind: 'navigate',
        action: { kind: 'settings', sectionId: 'members' },
      });
    return Response.json({ ok: true });
  });
});
afterEach(cleanup);

it('registers the command window, exposes declared targets and acknowledges the engine open result', async () => {
  renderHook(() => useConsoleCommandBindings(true), undefined, hub);
  await act(async () => {});
  expect(wire.socket.emit).toHaveBeenCalledWith('join_room', 'workspace:navigate:ack');
  const inspect = vi.fn();
  await act(async () => wire.server('home:inspect', {}, inspect));
  expect(inspect).toHaveBeenCalledWith({ clientId, clientToken, ...observed });
  const receipt = vi.fn();
  await act(async () => wire.server('home:execute', { clientId, token, expiresAt: Date.now() + 5000 }, receipt));
  expect(emit).toHaveBeenCalledWith(
    'home:execute',
    expect.objectContaining({ action: { kind: 'settings', sectionId: 'members' } }),
  );
  expect(receipt).toHaveBeenCalledWith({ clientId, clientToken, token, status: 'applied' });
  emit.mockImplementation((event: string) => (event === 'home:inspect' ? observed : false));
  await act(async () => wire.server('home:execute', { clientId, token, expiresAt: Date.now() + 5000 }, receipt));
  expect(receipt).toHaveBeenLastCalledWith({ clientId, token, status: 'blocked' });
  expect(emit.mock.calls.filter(([event]) => event === 'home:execute')).toHaveLength(1);
});

it('cancels a grant read before it can run an engine action', async () => {
  renderHook(() => useConsoleCommandBindings(true), undefined, hub);
  await act(async () => {});
  let finish!: (response: Response) => void, signal!: AbortSignal;
  vi.mocked(apiFetch).mockImplementation((_path, init) => {
    signal = init!.signal as AbortSignal;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const receipt = vi.fn();
  await act(async () => wire.server('home:execute', { clientId, token, expiresAt: Date.now() + 5000 }, receipt));
  await act(async () => wire.server('home:cancel', { clientId, token }));
  expect(signal.aborted).toBe(true);
  await act(async () =>
    finish(
      Response.json({
        clientId,
        baseRoute: observed.route,
        expiresAt: Date.now() + 5000,
        kind: 'navigate',
        action: { kind: 'settings', sectionId: 'members' },
      }),
    ),
  );
  expect(receipt).toHaveBeenCalledWith({ clientId, clientToken, token, status: 'blocked' });
  expect(emit.mock.calls.filter(([event]) => event === 'home:execute')).toEqual([]);
  vi.mocked(apiFetch).mockResolvedValue(Response.json({ ok: true }));
});

it('runs workspace commands on arrival and reports failure without a deferred command', async () => {
  renderHook(() => useConsoleCommandBindings(true), undefined, hub);
  await act(async () => {});
  const data = {
    eventId: 'navigate',
    threadId: 'another-thread',
    path: 'src/file.ts',
    worktreeId: 'owner',
    action: 'open',
  };
  const receipt = vi.fn();
  await act(async () => wire.server('workspace:navigate', data, receipt));
  expect(emit).toHaveBeenCalledWith('workspace:navigate', data);
  expect(receipt).toHaveBeenCalledWith({ eventId: 'navigate', status: 'applied' });
  emit.mockImplementation(() => false);
  await act(async () => wire.server('workspace:navigate', data, receipt));
  expect(receipt).toHaveBeenLastCalledWith({ eventId: 'navigate', status: 'blocked' });
});

it('hands an immediate preview open to the engine while the console is active', async () => {
  const hook = renderHook(() => useConsoleCommandBindings(true), undefined, hub);
  await act(async () => {});
  const command = { data: { port: 5173, threadId: 'current' }, ran: false };
  window.dispatchEvent(new CustomEvent('preview:auto-open', { detail: command }));
  expect(command.ran).toBe(true);
  expect(emit).toHaveBeenCalledWith('preview:auto-open', command.data);
  await act(hook.rerender);
  expect(emit.mock.calls.filter(([event]) => event === 'preview:auto-open')).toHaveLength(1);
});
