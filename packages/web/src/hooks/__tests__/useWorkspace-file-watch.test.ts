// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHubSocket, type FakeHubSocket, withHubSocket } from '@/test-utils/fake-hub-socket';
import { useWorkspaceFileChange } from '../useWorkspaceFileChange';

let root: Root;
let fake: FakeHubSocket;
const onReload = vi.fn();
function WatchHost({ sha }: { sha: string | null }) {
  useWorkspaceFileChange({ worktreeId: 'wt-1', path: 'README.md', currentSha: sha, onReload });
  return null;
}
async function render(sha: string | null) {
  await act(async () => root.render(createElement(WatchHost, { sha })));
  expect(fake.listenerCount('workspace:file-changed')).toBe(1);
}
/** Connects the page connection and returns the watchId the hook subscribed with. */
function connect(): string {
  act(() => {
    fake.connect();
  });
  return (fake.emitted('workspace:watch-file')[0]?.[0] as { watchId: string }).watchId;
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fake = createFakeHubSocket();
  root = withHubSocket(createRoot(document.createElement('div')), fake.hub);
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
    act(() => fake.deliver('workspace:file-changed', { watchId, ...event }));
    expect(onReload).not.toHaveBeenCalled();
  });

  it("ignores another watch's change and releases only its own watch", async () => {
    await render('sha-current');
    const watchId = connect();
    act(() =>
      fake.deliver('workspace:file-changed', {
        watchId: 'another-watch',
        worktreeId: 'wt-1',
        path: 'README.md',
        sha256: 'sha-new',
      }),
    );
    expect(onReload).not.toHaveBeenCalled();

    act(() => root.unmount());
    expect(fake.emitted('workspace:unwatch-file')).toEqual([[{ watchId }]]);
    root = createRoot(document.createElement('div'));
  });

  it('reloads an event received before the initial content hash is available', async () => {
    await render(null);
    const watchId = connect();
    expect(fake.emitted('workspace:watch-file')[0]?.[0]).toEqual({
      watchId,
      worktreeId: 'wt-1',
      path: 'README.md',
      sha256: null,
    });
    act(() =>
      fake.deliver('workspace:file-changed', {
        watchId,
        worktreeId: 'wt-1',
        path: 'README.md',
        sha256: 'sha-new',
      }),
    );
    expect(onReload).toHaveBeenCalledExactlyOnceWith('README.md');
  });
});
