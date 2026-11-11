import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WorktreeEntry } from '@/hooks/useWorkspace';
import { apiFetch } from '@/utils/api-client';
import { useTerminalBindings } from '../useTerminalBindings';
import { act, cleanup, renderHook, waitFor } from './hook-host';
import { createOwnerConsole, useOwnerProjection } from './owner-console';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: 'https://api.test' }));
class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  sent: unknown[] = [];
  onopen = () => {};
  onclose = () => {};
  onerror = () => {};
  onmessage: (event: { data: string }) => void = () => {};
  constructor(readonly url: string) {
    Socket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = 1;
    this.onopen();
  }
  close() {
    this.readyState = 3;
    this.onclose();
  }
  receive(data: string) {
    this.onmessage({ data });
  }
}
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const worktrees = [{ id: 'wt', root: '/project', branch: 'topic' }] as WorktreeEntry[];
let scope: string, ui: { pane: string }, emit: ReturnType<typeof vi.fn>;
let closeOwner: () => Promise<Response>, createOwner: () => Promise<Response>;
beforeEach(() => {
  vi.clearAllMocks();
  scope = 'wt';
  ui = { pane: 'mine' };
  emit = vi.fn();
  Socket.all = [];
  closeOwner = async () => response({ ok: true });
  createOwner = async () => response({ sessionId: 'session-real', paneId: '%1', reconnected: true });
  vi.stubGlobal('WebSocket', Socket);
  window.clowderChat = { emit } as unknown as typeof window.clowderChat;
  vi.mocked(apiFetch).mockImplementation(async (raw, init) => {
    const url = new URL(String(raw), 'https://api.test');
    if (url.pathname === '/api/terminal/status') return response({ available: true });
    if (url.pathname === '/api/terminal/agent-panes')
      return response([{ invocationId: 'invoke-real', paneId: '%2', catId: 'codex', status: 'running', startedAt: 1 }]);
    if (url.pathname === '/api/terminal/sessions' && init?.method === 'POST') return createOwner();
    if (url.pathname === '/api/terminal/sessions/session-real' && init?.method === 'DELETE') return closeOwner();
    throw new Error('Unexpected terminal owner ' + raw);
  });
});
afterEach(async () => {
  await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
let visible = false;
async function ready() {
  visible = false;
  let renderCount = 0;
  const hook = renderHook(() => {
    renderCount++;
    return useOwnerProjection('terminal', useTerminalBindings(scope, ui, visible), {
      ws: ui,
      sources: { workbench: { workspace: { worktreeId: scope, worktrees } } },
    });
  });
  expect(apiFetch).not.toHaveBeenCalled();
  emit.mockImplementation((event, data) => {
    if (event === 'terminal:output') {
      hook.result.current.console.context.__terminalOutput = data;
      hook.result.current.console.read('receiveTerminalOutput(__terminalOutput)');
    }
  });
  await act(() => {
    visible = true;
    hook.rerender();
  });
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  expect(hook.result.current.project().terminal?.load).toBe('loading');
  await act(() => Socket.all[0].open());
  expect(hook.result.current.project().terminal?.load).toBe('');
  return { ...hook, renderCount: () => renderCount };
}
it('connects the real worktree session, forwards raw PTY output through io and keeps an identical remount snapshot', async () => {
  const hook = await ready(),
    socket = Socket.all[0];
  expect(socket.url).toBe('wss://api.test/api/terminal/sessions/session-real/ws');
  const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(String(call[1]?.body))).toEqual({ worktreeId: 'wt', cols: 80, rows: 24 });
  const renders = hook.renderCount();
  await act(() => {
    socket.receive('\u001b[31');
    socket.receive('mred\rOK\u001b[K');
  });
  expect(hook.renderCount()).toBe(renders);
  expect(emit.mock.calls).toEqual([
    ['terminal:output', { id: 'session-real', data: '\u001b[31' }],
    ['terminal:output', { id: 'session-real', data: 'mred\rOK\u001b[K' }],
  ]);
  expect(hook.result.current.project().terminal?.screen.output).toBe('\u001b[31mred\rOK\u001b[K');
  await act(() => hook.result.current.action('terminal:input', { id: 'session-real', data: '\u0003\u001b[A' }));
  await act(() => hook.result.current.action('terminal:resize', { id: 'session-real', cols: '101', rows: '31' }));
  expect(socket.sent).toEqual([
    { type: 'resize', cols: 80, rows: 24 },
    { type: 'input', data: '\u0003\u001b[A' },
    { type: 'resize', cols: 101, rows: 31 },
  ]);
});
it('observes registered agent panes through their read-only owner and refuses their input', async () => {
  const hook = await ready();
  ui.pane = '%2';
  await act(() => hook.result.current.action('terminal:select', {}));
  const socket = Socket.all[1];
  expect(socket.url).toBe('wss://api.test/api/terminal/agent-panes/%252/ws?worktreeId=wt');
  await act(() => socket.open());
  await act(() => socket.receive('agent output'));
  expect(hook.result.current.project().terminal).toMatchObject({
    ro: true,
    screen: { id: '%2', mine: false, output: 'agent output' },
  });
  await act(() => hook.result.current.action('terminal:input', { id: '%2', data: 'forbidden' }));
  expect(socket.sent).toEqual([{ type: 'resize', cols: 80, rows: 24 }]);
});
it('closes the bridge on hide without deleting the server-owned session and ignores its later frames', async () => {
  const hook = await ready(),
    socket = Socket.all[0];
  await act(() => {
    visible = false;
    hook.rerender();
  });
  expect(socket.readyState).toBe(3);
  socket.receive('stale');
  expect(emit).not.toHaveBeenCalled();
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
});
it('preserves the session on a refused delete and only clears it after its owner acknowledges', async () => {
  const hook = await ready();
  await act(() => Socket.all[0].receive('owned history'));
  closeOwner = async () => response({ error: 'owner_denied' }, 403);
  await act(async () => {
    await expect(hook.result.current.action('terminal:close', { id: 'session-real' })).rejects.toThrow('owner_denied');
  });
  expect(hook.result.current.project().terminal?.mineId).toBe('session-real');
  expect(hook.result.current.project().terminal?.screen.output).toBe('owned history');
  let receipt!: (value: Response) => void;
  closeOwner = () =>
    new Promise((resolve) => {
      receipt = resolve;
    });
  let pending!: Promise<boolean>;
  await act(() => {
    pending = hook.result.current.action('terminal:close', { id: 'session-real' });
  });
  expect(hook.result.current.project().terminal?.mineId).toBe('session-real');
  await act(async () => {
    receipt(response({ ok: true }));
    await pending;
  });
  expect(hook.result.current.project().terminal?.mineId).toBe('');
  expect(hook.result.current.project().terminal?.screen.output).toBe('');
});
it('releases a late create bridge after leaving the tool, preserving the tmux owner for reconnection', async () => {
  let receipt!: (value: Response) => void;
  createOwner = () =>
    new Promise((resolve) => {
      receipt = resolve;
    });
  visible = false;
  const hook = renderHook(() =>
    useOwnerProjection('terminal', useTerminalBindings(scope, ui, visible), {
      ws: ui,
      sources: { workbench: { workspace: { worktreeId: scope, worktrees } } },
    }),
  );
  await act(() => {
    visible = true;
    hook.rerender();
  });
  await waitFor(() => expect(receipt).toBeTypeOf('function'));
  await act(() => {
    visible = false;
    hook.rerender();
  });
  await act(() => receipt(response({ sessionId: 'late-session', paneId: '%3', reconnected: false })));
  expect(Socket.all[0].url).toContain('/late-session/ws');
  Socket.all[0].open();
  expect(Socket.all[0].readyState).toBe(3);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
});

it('publishes changed terminal dimensions and ignores a duplicate resize without sending or publishing again', async () => {
  const console = createOwnerConsole({
    ws: ui,
    sources: { workbench: { workspace: { worktreeId: scope, worktrees } } },
  });
  const render = vi.fn();
  Object.assign(console.context, { render });
  const publish = vi.fn((source: ReturnType<typeof useTerminalBindings>['data']) => {
    console.context.__incoming = { terminal: source };
    console.read('pushProjectData(__incoming)');
  });
  visible = false;
  const hook = renderHook(() => {
    const binding = useTerminalBindings(scope, ui, visible);
    publish(binding.data);
    return binding;
  });
  await act(() => {
    visible = true;
    hook.rerender();
  });
  await waitFor(() => expect(Socket.all).toHaveLength(1));
  const socket = Socket.all[0];
  await act(() => socket.open());
  const held = console.read("projectData('terminal').mine");
  expect(held).toMatchObject({ cols: 80, rows: 24 });
  publish.mockClear();
  render.mockClear();
  await act(() => hook.result.current.action('terminal:resize', { id: 'session-real', cols: '101', rows: '31' }));
  expect(publish).toHaveBeenCalledOnce();
  // A changed field is named by its full path: only what reads the terminal size redraws.
  expect(render).toHaveBeenCalledExactlyOnceWith(true);
  const resized = console.read("projectData('terminal').mine");
  expect(resized).toMatchObject({ cols: 101, rows: 31 });
  expect(resized).not.toBe(held);
  await act(() => hook.result.current.action('terminal:resize', { id: 'session-real', cols: '101', rows: '31' }));
  expect(publish).toHaveBeenCalledOnce();
  expect(render).toHaveBeenCalledOnce();
  expect(console.read("projectData('terminal').mine")).toBe(resized);
  expect(socket.sent).toEqual([
    { type: 'resize', cols: 80, rows: 24 },
    { type: 'resize', cols: 101, rows: 31 },
  ]);
});
