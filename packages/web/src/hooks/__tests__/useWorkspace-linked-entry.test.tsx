import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTerminalWorktreeId } from '@/components/workbench/real-surface-adapters';
import { workspaceHomeDestinationToSurface } from '@/components/workbench/workspace-home-adapter';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useWorkspace } from '../useWorkspace';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));

const MAIN_ROOT = '/tmp/cafe-main';
const LINKED_ROOT = '/tmp/cafe-linked';
const entries = [
  { id: 'cafe-main', root: MAIN_ROOT, branch: 'main', head: 'main-head' },
  { id: 'cafe-linked', root: LINKED_ROOT, branch: 'feat/linked', head: 'linked-head' },
];

function TerminalEntry({ projectPath }: { projectPath: string | null }) {
  const { worktrees, worktreeId } = useWorkspace({ loadContent: false, projectPath });
  const selected = worktrees.find((entry) => entry.id === worktreeId);
  const surface = workspaceHomeDestinationToSurface(
    { kind: 'surface', id: 'terminal', label: '终端', description: '终端', searchTerms: 'terminal' },
    {
      threadId: 'linked-thread',
      worktreeId: selected?.id ?? null,
      canonicalWorktreeId: selected?.canonicalId ?? selected?.id,
      openFilePath: null,
      preview: { path: '/' },
    },
  );
  return <output data-terminal-worktree={surface ? resolveTerminalWorktreeId(surface) : ''} />;
}

describe('linked-worktree first entry and selected Terminal owner', () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      currentThreadId: 'linked-thread',
      currentProjectPath: 'default',
      threadStates: {},
      workspaceWorktreeId: null,
      workspaceWorktreeAliases: {},
      workspaceWorktreeAliasesProjectPath: null,
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceOpenTabs: [],
      presentationLock: null,
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ worktrees: entries }) } as Response);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    fetchMock.mockReset();
    delete (globalThis as { React?: typeof React }).React;
  });

  async function render(projectPath: string | null) {
    await act(async () => root.render(<TerminalEntry projectPath={projectPath} />));
  }

  it('waits for the thread project before discovery, then opens the linked Terminal owner', async () => {
    await render(null);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useChatStore.getState().workspaceWorktreeId).toBeNull();
    expect(container.querySelector('output')?.dataset.terminalWorktree).toBe('');

    await act(async () => useChatStore.getState().setCurrentProject(LINKED_ROOT));
    await render(LINKED_ROOT);
    expect(fetchMock).toHaveBeenCalledWith(`/api/workspace/worktrees?repoRoot=${encodeURIComponent(LINKED_ROOT)}`);
    expect(useChatStore.getState().workspaceWorktreeId).toBe('cafe-linked');
    expect(container.querySelector('output')?.dataset.terminalWorktree).toBe('cafe-linked');
  });

  it('preserves an explicitly selected main worktree even in a linked-project thread', async () => {
    useChatStore.setState({ currentProjectPath: LINKED_ROOT, workspaceWorktreeId: 'cafe-main' });
    await render(LINKED_ROOT);
    expect(useChatStore.getState().workspaceWorktreeId).toBe('cafe-main');
    expect(container.querySelector('output')?.dataset.terminalWorktree).toBe('cafe-main');
  });

  it('allows the virtual default conversation to discover its deliberate startup repository', async () => {
    await render('default');
    expect(fetchMock).toHaveBeenCalledWith('/api/workspace/worktrees');
    expect(container.querySelector('output')?.dataset.terminalWorktree).toBe('cafe-main');
  });

  it('restores each thread selection and constructs its own Terminal owner on return', async () => {
    useChatStore.setState({ currentProjectPath: LINKED_ROOT });
    await render(LINKED_ROOT);
    await act(async () => {
      useChatStore.getState().setCurrentThread('main-thread');
      useChatStore.getState().setWorkspaceWorktreeId('cafe-main');
      useChatStore.getState().setCurrentProject(MAIN_ROOT);
    });
    await render(MAIN_ROOT);
    expect(container.querySelector('output')?.dataset.terminalWorktree).toBe('cafe-main');
    await act(async () => {
      useChatStore.getState().setCurrentThread('linked-thread');
      useChatStore.getState().setCurrentProject(LINKED_ROOT);
    });
    await render(LINKED_ROOT);
    expect(useChatStore.getState().workspaceWorktreeId).toBe('cafe-linked');
    expect(container.querySelector('output')?.dataset.terminalWorktree).toBe('cafe-linked');
  });

  it('retains the listed selection but addresses panes under the same root canonical owner', async () => {
    useChatStore.setState({ currentProjectPath: MAIN_ROOT, workspaceWorktreeId: '230809_cafe-main' });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        worktrees: [
          { ...entries[0], id: '230809_cafe-main', canonicalId: 'cafe-main' },
          { ...entries[1], id: '230809_cafe-linked', canonicalId: 'cafe-linked' },
        ],
      }),
    } as Response);
    await render(MAIN_ROOT);
    expect(useChatStore.getState().workspaceWorktreeId).toBe('230809_cafe-main');
    expect(container.querySelector('output')?.dataset.terminalWorktree).toBe('cafe-main');
  });
});
