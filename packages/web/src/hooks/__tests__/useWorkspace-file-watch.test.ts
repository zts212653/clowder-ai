// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceFileChange } from '../useWorkspaceFileChange';

const socket = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => void>(),
  emit: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (name: string, handler: (...args: unknown[]) => void) => socket.handlers.set(name, handler),
    emit: socket.emit,
    disconnect: socket.disconnect,
  }),
}));

let root: Root;
const onReload = vi.fn();
function WatchHost({ sha }: { sha: string | null }) {
  useWorkspaceFileChange({ worktreeId: 'wt-1', path: 'README.md', currentSha: sha, onReload });
  return null;
}
async function render(sha: string | null) {
  await act(async () => root.render(createElement(WatchHost, { sha })));
  await vi.waitFor(() => expect(socket.handlers.has('workspace:file-changed')).toBe(true));
}
/** Connects the mocked socket and returns the watchId the hook subscribed with. */
function connect(): string {
  act(() => socket.handlers.get('connect')!());
  const watch = socket.emit.mock.calls.find(([name]) => name === 'workspace:watch-file');
  return (watch?.[1] as { watchId: string }).watchId;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement('div'));
  socket.handlers.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

// Clean reload, dirty draft preservation and worktree isolation are exercised by
// F307FileOwnerSurface.continuity.test.tsx through the real file owner and this hook.
describe('production workspace file watcher resource boundaries', () => {
  it.each([
    ['unchanged content', { worktreeId: 'wt-1', path: 'README.md', sha256: 'sha-current' }],
    ['a different path', { worktreeId: 'wt-1', path: 'other.ts', sha256: 'sha-new' }],
  ])('ignores %s received through the socket subscription', async (_label, event) => {
    await render('sha-current');
    const watchId = connect();
    act(() => socket.handlers.get('workspace:file-changed')!({ watchId, ...event }));
    expect(onReload).not.toHaveBeenCalled();
  });

  it("ignores another watch's change and releases only its own watch", async () => {
    await render('sha-current');
    const watchId = connect();
    act(() =>
      socket.handlers.get('workspace:file-changed')!({
        watchId: 'another-watch',
        worktreeId: 'wt-1',
        path: 'README.md',
        sha256: 'sha-new',
      }),
    );
    expect(onReload).not.toHaveBeenCalled();

    act(() => root.unmount());
    expect(socket.emit).toHaveBeenLastCalledWith('workspace:unwatch-file', { watchId });
    root = createRoot(document.createElement('div'));
  });

  it('reloads an event received before the initial content hash is available', async () => {
    await render(null);
    const watchId = connect();
    expect(socket.emit).toHaveBeenCalledWith('workspace:watch-file', {
      watchId,
      worktreeId: 'wt-1',
      path: 'README.md',
      sha256: null,
    });
    act(() =>
      socket.handlers.get('workspace:file-changed')!({
        watchId,
        worktreeId: 'wt-1',
        path: 'README.md',
        sha256: 'sha-new',
      }),
    );
    expect(onReload).toHaveBeenCalledExactlyOnceWith('README.md');
  });
});
