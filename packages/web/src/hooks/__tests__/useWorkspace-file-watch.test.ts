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
    act(() => socket.handlers.get('workspace:file-changed')!(event));
    expect(onReload).not.toHaveBeenCalled();
  });

  it('reloads an event received before the initial content hash is available', async () => {
    await render(null);
    act(() => socket.handlers.get('connect')!());
    expect(socket.emit).toHaveBeenCalledWith('workspace:watch-file', {
      worktreeId: 'wt-1',
      path: 'README.md',
      sha256: null,
    });
    act(() =>
      socket.handlers.get('workspace:file-changed')!({
        worktreeId: 'wt-1',
        path: 'README.md',
        sha256: 'sha-new',
      }),
    );
    expect(onReload).toHaveBeenCalledExactlyOnceWith('README.md');
  });
});
