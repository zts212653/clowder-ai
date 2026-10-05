import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { SettingsWorkspaceLink } from '../SettingsWorkspaceLink';

const mocks = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => mocks }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
const initial = useChatStore.getState();
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  mocks.push.mockReset();
  window.history.replaceState({}, '', '/settings?s=env');
  useChatStore.setState({
    currentThreadId: 'foreign-thread',
    currentProjectPath: '/foreign',
    threads: [],
    workspaceOpenFilePath: null,
  });
});
afterEach(() => {
  useChatStore.setState(initial, true);
  vi.restoreAllMocks();
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

it('discovers the actual settings root rather than opening the same filename in the prior project', async ({
  onTestFinished,
}) => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        worktrees: [
          { id: 'wrong', root: '/foreign', branch: 'main', head: 'abc12345' },
          { id: 'exact-root', root: '/settings-project', branch: 'main', head: 'abc12345' },
        ],
      }),
    ),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(<SettingsWorkspaceLink kind="file" relPath="AGENTS.md" projectRoot="/settings-project" />),
  );
  await act(async () => container.querySelector('button')!.click());
  const state = useChatStore.getState();
  // The destination restores its own project on mount; the exact file travels as a consume-once
  // Workbench request that survives the route change (parent Alpha: entry 8 fell back to the lobby).
  expect(state.currentProjectPath).toBe('/foreign');
  expect(state.rightPanelMode).toBe('workspace');
  expect(state.workspaceOpenRequest).toMatchObject({
    threadId: 'default',
    target: {
      kind: 'file',
      worktreeId: 'exact-root',
      path: 'AGENTS.md',
      navigationOrigin: {
        kind: 'settings',
        href: '/settings?s=env',
        anchorId: 'settings-file:AGENTS.md',
        viewportOffsetPx: 0,
      },
    },
  });
  expect(mocks.push).toHaveBeenCalledWith('/');
});

it('a late settings lookup cannot pull the user out of another page', async ({ onTestFinished }) => {
  let resolve!: (response: Response) => void;
  vi.mocked(apiFetch).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(<SettingsWorkspaceLink kind="file" relPath="AGENTS.md" projectRoot="/settings-project" />),
  );
  await act(async () => container.querySelector('button')!.click());
  window.history.replaceState({}, '', '/thread/another');
  await act(async () =>
    resolve(
      new Response(
        JSON.stringify({ worktrees: [{ id: 'exact', root: '/settings-project', branch: 'main', head: 'abc12345' }] }),
      ),
    ),
  );
  expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  expect(mocks.push).not.toHaveBeenCalled();
});

it('missing exact root remains at the source with a visible error', async ({ onTestFinished }) => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ worktrees: [{ id: 'wrong', root: '/foreign', branch: 'main', head: 'abc12345' }] })),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(<SettingsWorkspaceLink kind="file" relPath="AGENTS.md" projectRoot="/settings-project" />),
  );
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('未能唯一定位');
  expect(useChatStore.getState().workspaceOpenFilePath).toBeNull();
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  expect(mocks.push).not.toHaveBeenCalled();
});

// Sol #4749 R3: the exact-root entry is read with the Files header's reader, so an entry it cannot read is unavailable.
it('a listing whose exact-root entry cannot be read stays at the source as unavailable', async ({ onTestFinished }) => {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ worktrees: [{ id: 'exact-root', root: '/settings-project' }] })),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(<SettingsWorkspaceLink kind="file" relPath="AGENTS.md" projectRoot="/settings-project" />),
  );
  await act(async () => container.querySelector('button')!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('工作区目录暂不可用');
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  expect(mocks.push).not.toHaveBeenCalled();
});

async function clickExactRootLink(
  onTestFinished: (fn: () => Promise<void>) => void,
  kind: 'file' | 'directory' = 'file',
  relPath = 'AGENTS.md',
) {
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(
      JSON.stringify({
        worktrees: [{ id: 'exact-root', root: '/settings-project', branch: 'main', head: 'abc12345' }],
      }),
    ),
  );
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  onTestFinished(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  await act(async () =>
    root.render(<SettingsWorkspaceLink kind={kind} relPath={relPath} projectRoot="/settings-project" />),
  );
  await act(async () => container.querySelector('button')?.click());
  return container;
}

// Parent Alpha 2026-09-24 (second round): a Settings data directory's "在 Hub 中查看" did nothing.
it('a settings directory link asks the Hub to show that exact directory in its worktree tree', async ({
  onTestFinished,
}) => {
  await clickExactRootLink(onTestFinished, 'directory', 'packages/api/uploads');
  const state = useChatStore.getState();
  expect(state.rightPanelMode).toBe('workspace');
  expect(state.workspaceOpenRequest).toMatchObject({
    threadId: 'default',
    target: {
      kind: 'reveal',
      worktreeId: 'exact-root',
      path: 'packages/api/uploads',
      navigationOrigin: { kind: 'settings', href: '/settings?s=env', anchorId: 'settings-dir:packages/api/uploads' },
      // The id was minted under this root; the tree reads its identity through it (parent Alpha 2026-09-25).
      repoRoot: '/settings-project',
    },
  });
  expect(mocks.push).toHaveBeenCalledWith('/');
});

it('a refused directory reveal stays on Settings and names the directory', async ({ onTestFinished }) => {
  useChatStore.setState({ openWorkspacePath: () => false });
  const container = await clickExactRootLink(onTestFinished, 'directory', 'packages/api/uploads');
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('未能切换到此目录所在的对话');
  expect(mocks.push).not.toHaveBeenCalled();
});

it('an explicit settings open is still honoured while a presentation lock is on', async ({ onTestFinished }) => {
  useChatStore.getState().enablePresentationLock();
  await clickExactRootLink(onTestFinished);
  expect(useChatStore.getState().workspaceOpenRequest).toMatchObject({
    threadId: 'default',
    target: { kind: 'file', worktreeId: 'exact-root', path: 'AGENTS.md' },
  });
  expect(mocks.push).toHaveBeenCalledWith('/');
});

it('a refused open request stays at the source with a reason instead of landing on an empty page', async ({
  onTestFinished,
}) => {
  useChatStore.setState({ openWorkspacePath: () => false });
  const container = await clickExactRootLink(onTestFinished);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('未能切换到此文件所在的对话');
  expect(useChatStore.getState().workspaceOpenRequest).toBeNull();
  expect(mocks.push).not.toHaveBeenCalled();
});
