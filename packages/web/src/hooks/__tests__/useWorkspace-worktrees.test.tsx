import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { useWorkspace } from '../useWorkspace';

vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3004',
  apiFetch: vi.fn(),
}));

function HookHost() {
  useWorkspace();
  return React.createElement('div');
}

async function flushEffects() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe('useWorkspace worktree refresh', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      currentProjectPath: '/tmp/current-project',
      workspaceWorktreeId: 'cat-cafe',
      workspaceWorktreeAliases: {},
      workspaceWorktreeAliasesProjectPath: null,
      workspaceOpenFilePath: 'docs/study.md',
      workspaceOpenFileLine: 7,
      workspaceOpenTabs: ['docs/study.md'],
      workspaceEditToken: null,
      workspaceEditTokenExpiry: null,
    });
    apiFetchMock.mockImplementation(async (url) => {
      const path = String(url);
      if (path.startsWith('/api/workspace/worktrees')) {
        return {
          ok: true,
          json: async () => ({
            worktrees: [
              {
                id: '230809_cat-cafe',
                canonicalId: 'cat-cafe',
                root: '/tmp/current-project',
                branch: 'main',
                head: 'abc1234',
              },
            ],
          }),
        } as Response;
      }
      if (path.startsWith('/api/workspace/tree')) {
        return { ok: true, json: async () => ({ tree: [] }) } as Response;
      }
      if (path.startsWith('/api/workspace/file')) {
        return {
          ok: true,
          json: async () => ({
            path: 'docs/study.md',
            content: '',
            sha256: 'sha',
            size: 0,
            mime: 'text/markdown',
            truncated: false,
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({ error: 'unexpected url' }) } as Response;
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    apiFetchMock.mockReset();
    useChatStore.setState({
      currentProjectPath: 'default',
      workspaceWorktreeId: null,
      workspaceWorktreeAliases: {},
      workspaceWorktreeAliasesProjectPath: null,
      workspaceOpenFilePath: null,
      workspaceOpenFileLine: null,
      workspaceOpenTabs: [],
    });
  });

  it('normalizes a canonical current worktree to the listed alias without clearing the open file', async () => {
    await act(async () => {
      root.render(React.createElement(HookHost));
    });
    await flushEffects();

    const state = useChatStore.getState();
    expect(state.workspaceWorktreeId).toBe('230809_cat-cafe');
    expect(state.workspaceOpenFilePath).toBe('docs/study.md');
    expect(state.workspaceOpenFileLine).toBe(7);
    expect(state.workspaceOpenTabs).toEqual(['docs/study.md']);

    const worktreeCalls = apiFetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/workspace/worktrees'));
    expect(worktreeCalls[0][0]).toBe('/api/workspace/worktrees?repoRoot=%2Ftmp%2Fcurrent-project');
    const treeAndFileCalls = apiFetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => url.startsWith('/api/workspace/tree') || url.startsWith('/api/workspace/file'));
    expect(treeAndFileCalls.some((url) => url.includes('worktreeId=230809_cat-cafe'))).toBe(true);
  });

  it('keeps an open default-repo worktree when the thread-scoped list does not contain it', async () => {
    useChatStore.setState({
      currentProjectPath: 'G:/AIwork/clowder-ai',
      workspaceWorktreeId: 'research-harness-landscape-20260801',
      workspaceOpenFilePath: 'project-research/harness/synthesis.md',
      workspaceOpenTabs: ['project-research/harness/synthesis.md'],
    });
    apiFetchMock.mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('repoRoot=')) {
        return {
          ok: true,
          json: async () => ({
            worktrees: [{ id: 'api', root: 'G:/AIwork/clowder-ai/clowder-ai-runtime/packages/api' }],
          }),
        } as Response;
      }
      if (path === '/api/workspace/worktrees') {
        return {
          ok: true,
          json: async () => ({
            worktrees: [
              {
                id: 'research-harness-landscape-20260801',
                root: 'G:/AIwork/clowder-ai/worktrees/research-harness-landscape-20260801',
              },
            ],
          }),
        } as Response;
      }
      if (path.startsWith('/api/workspace/tree')) {
        return { ok: true, json: async () => ({ tree: [] }) } as Response;
      }
      if (path.startsWith('/api/workspace/file')) {
        return {
          ok: true,
          json: async () => ({
            path: 'project-research/harness/synthesis.md',
            content: 'report',
            sha256: 'sha',
            size: 6,
            mime: 'text/markdown',
            truncated: false,
          }),
        } as Response;
      }
      return { ok: false, json: async () => ({ error: 'unexpected url' }) } as Response;
    });

    await act(async () => {
      root.render(React.createElement(HookHost));
    });
    await flushEffects();

    expect(apiFetchMock.mock.calls.map(([url]) => url)).toContain('/api/workspace/worktrees');
    expect(useChatStore.getState()).toMatchObject({
      workspaceWorktreeId: 'research-harness-landscape-20260801',
      workspaceOpenFilePath: 'project-research/harness/synthesis.md',
      workspaceOpenTabs: ['project-research/harness/synthesis.md'],
    });
  });

  it('does not keep a default-repo worktree outside the current project path', async () => {
    useChatStore.setState({
      currentProjectPath: 'G:/other-project',
      workspaceWorktreeId: 'research-harness-landscape-20260801',
      workspaceOpenFilePath: 'project-research/harness/synthesis.md',
      workspaceOpenTabs: ['project-research/harness/synthesis.md'],
    });
    apiFetchMock.mockImplementation(async (url) => {
      const path = String(url);
      if (path.includes('repoRoot=')) {
        return {
          ok: true,
          json: async () => ({
            worktrees: [{ id: 'other-project', root: 'G:/other-project' }],
          }),
        } as Response;
      }
      if (path === '/api/workspace/worktrees') {
        return {
          ok: true,
          json: async () => ({
            worktrees: [
              {
                id: 'research-harness-landscape-20260801',
                root: 'G:/AIwork/clowder-ai/worktrees/research-harness-landscape-20260801',
              },
            ],
          }),
        } as Response;
      }
      if (path.startsWith('/api/workspace/tree')) {
        return { ok: true, json: async () => ({ tree: [] }) } as Response;
      }
      return { ok: false, json: async () => ({ error: 'unexpected url' }) } as Response;
    });

    await act(async () => {
      root.render(React.createElement(HookHost));
    });
    await flushEffects();

    expect(useChatStore.getState()).toMatchObject({
      workspaceWorktreeId: 'other-project',
      workspaceOpenFilePath: null,
      workspaceOpenTabs: [],
    });
  });
});
