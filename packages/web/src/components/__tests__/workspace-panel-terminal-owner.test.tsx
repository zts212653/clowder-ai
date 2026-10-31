import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { WorkspacePanel } from '../WorkspacePanel';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
// Keep discovery, the real Panel/Home/descriptor/renderer chain and its selection.
// The endpoint consumer reports its received identity without starting a terminal.
vi.mock('@/components/workspace/TerminalTab', () => ({
  TerminalTab: ({ worktreeId }: { worktreeId: string }) => <output data-terminal-query-owner={worktreeId} />,
}));

describe('Workspace Panel selected Terminal identity', () => {
  let container: HTMLDivElement;
  let root: Root;
  const worktrees = [
    { id: '230809_cafe-main', canonicalId: 'cafe-main', root: '/tmp/cafe-main', branch: 'main', head: 'a' },
    { id: '230809_cafe-linked', canonicalId: 'cafe-linked', root: '/tmp/cafe-linked', branch: 'linked', head: 'b' },
  ];

  beforeEach(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    writeShellPresentation('v2');
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState(),
      hydrated: true,
      focusSurfaceId: null,
      mainAreaAttentionSurfaceId: null,
    });
    useChatStore.setState({
      currentThreadId: 'linked-thread',
      currentProjectPath: '/tmp/cafe-linked',
      workspaceSurface: 'home',
      workspaceWorktreeId: null,
      workspaceForegroundSurfaceId: null,
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceOpenTabs: [],
      workspaceWorktreeAliases: {},
      workspaceWorktreeAliasesProjectPath: null,
      presentationLock: null,
      threadStates: {},
    });
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ worktrees, files: [], executions: [], items: [] }),
    } as Response);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
    window.localStorage.clear();
    vi.mocked(apiFetch).mockReset();
    vi.restoreAllMocks();
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function openTerminal() {
    await act(async () => {
      root.render(<WorkspacePanel threadId="linked-thread" projectPath="/tmp/cafe-linked" />);
    });
    const trigger = container.querySelector<HTMLElement>('[data-testid="v2-workspace-tools"]');
    const details = trigger?.closest('details');
    if (!trigger || !details) throw new Error('Missing original + menu');
    vi.spyOn(trigger, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 32, 32)] as unknown as DOMRectList);
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    const button = document.querySelector<HTMLButtonElement>('[data-workspace-destination="surface:terminal"]');
    expect(button).not.toBeNull();
    await act(async () => button?.click());
    return container.querySelector('output[data-terminal-query-owner]')?.getAttribute('data-terminal-query-owner');
  }

  it('uses the linked entry canonical pane owner through the real Home and renderer', async () => {
    expect(await openTerminal()).toBe('cafe-linked');
    expect(useChatStore.getState().workspaceWorktreeId).toBe('230809_cafe-linked');
  });

  it('keeps an explicit main selection and queries that entry, without falling back to the linked root', async () => {
    useChatStore.setState({ workspaceWorktreeId: '230809_cafe-main' });
    expect(await openTerminal()).toBe('cafe-main');
    expect(useChatStore.getState().workspaceWorktreeId).toBe('230809_cafe-main');
  });
});
