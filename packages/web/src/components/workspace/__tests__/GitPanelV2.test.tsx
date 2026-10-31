import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { useChatStore } from '@/stores/chatStore';
import { GitPanel } from '../GitPanel';

Object.assign(globalThis as Record<string, unknown>, { React });

const apiFetchMock = vi.fn();
vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const RECENT = new Date(Date.now() - 30_000).toISOString();

const LOG = {
  commits: [{ hash: 'abc123def456', short: 'abc123', author: '墨墨', date: RECENT, subject: 'feat: 代码组' }],
};
const STATUS = {
  branch: 'feat/f322-v2-code-tools',
  staged: [{ status: 'M', path: 'packages/web/a.ts' }],
  unstaged: [{ status: 'M', path: 'packages/web/b.ts' }],
  untracked: [],
};
const HEALTH = {
  staleBranches: [{ name: 'feat/old', lastCommitDate: RECENT, author: '布偶猫', mergedInto: 'main' }],
  worktrees: [{ path: '/repo/wt', branch: 'feat/f322-v2-code-tools', head: 'abc123', isOrphan: false }],
  runtimeDrift: {
    available: true,
    aheadOfMain: 1,
    behindMain: 3,
    runtimeHead: 'rt',
    mainHead: 'mn',
    behindCommits: [{ short: 'zzz999', subject: 'chore: older main commit' }],
  },
};
const SHOW = { hash: 'abc123def456', files: [{ path: 'packages/web/a.ts', summary: '+2 -1' }] };

describe('GitPanel shell presentations', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    writeShellPresentation('v2');
    useChatStore.setState({ workspaceWorktreeId: 'wt-1' });
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('git-log')) return Response.json(LOG);
      if (url.includes('git-status')) return Response.json(STATUS);
      if (url.includes('git-health')) return Response.json(HEALTH);
      if (url.includes('git-show')) return Response.json(SHOW);
      return new Response('not found', { status: 404 });
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    writeShellPresentation('classic');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render() {
    await act(async () => {
      root.render(<GitPanel />);
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
  }

  it.each(['commit', 'behind-main'] as const)('keeps classic %s subjects in the recovery primitive', async (kind) => {
    writeShellPresentation('classic');
    await render();
    const blocks = [...container.querySelectorAll('[data-overflow-measure="block"]')];
    const subject = kind === 'commit' ? LOG.commits[0].subject : HEALTH.runtimeDrift.behindCommits[0].subject;
    expect(blocks.map((node) => node.textContent)).toContain(subject);
  });

  it('renders branch, Chinese collapsible sections and the read-only footer', async () => {
    await render();
    expect(container.textContent).toContain('分支 feat/f322-v2-code-tools');
    expect(container.textContent).toContain('状态（2 处改动）');
    expect(container.textContent).toContain('已暂存');
    expect(container.textContent).toContain('已修改');
    expect(container.textContent).toContain('仓库健康');
    expect(container.textContent).toContain('提交（1）');
    expect(container.textContent).toContain('只读：这里不做提交、推送或开 PR');
    expect(container.textContent).toContain('刷新');
  });

  it('shows drift and repo health details in Chinese', async () => {
    await render();
    expect(container.textContent).toContain('runtime 领先 main 1 · 落后 3');
    expect(container.textContent).toContain('落后 main 的提交（1）');
    expect(container.textContent).toContain('已合入的分支（1）');
    expect(container.textContent).toContain('使用中');
  });

  it('renders relative dates in Chinese', async () => {
    await render();
    expect(container.textContent).toContain('刚刚');
  });

  it('expands a commit to fetch and show its file detail', async () => {
    await render();
    const detailButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('查看详情'),
    );
    expect(detailButton).toBeTruthy();
    await act(async () => {
      detailButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i++) await Promise.resolve();
    });
    expect(apiFetchMock.mock.calls.some(([url]) => String(url).includes('git-show'))).toBe(true);
    expect(container.textContent).toContain('packages/web/a.ts');
    expect(container.textContent).toContain('+2 -1');
  });

  it('never claims a clean tree when git-status failed', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('git-status')) return new Response('boom', { status: 500 });
      if (url.includes('git-log')) return Response.json(LOG);
      if (url.includes('git-health')) return Response.json(HEALTH);
      return new Response('not found', { status: 404 });
    });
    await render();
    expect(container.textContent).not.toContain('工作区干净');
    expect(container.textContent).not.toContain('状态（0 处改动）');
  });

  it('keeps the runtime object on drift numbers instead of implying the current branch', async () => {
    await render();
    expect(container.textContent).toContain('runtime');
    expect(container.textContent).toContain('rt');
    expect(container.textContent).toContain('mn');
  });

  it('shows worktree directory name and short HEAD in repo health', async () => {
    await render();
    expect(container.textContent).toContain('wt');
    expect(container.textContent).toContain('abc123');
  });

  it('failed refresh after a clean read does not keep claiming clean', async () => {
    let statusFails = false;
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('git-status')) {
        return statusFails
          ? new Response('boom', { status: 500 })
          : Response.json({ branch: 'feat/x', staged: [], unstaged: [], untracked: [] });
      }
      if (url.includes('git-log')) return Response.json(LOG);
      if (url.includes('git-health')) return Response.json(HEALTH);
      return new Response('not found', { status: 404 });
    });
    await render();
    expect(container.textContent).toContain('工作区干净');

    statusFails = true;
    const refreshButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '刷新',
    );
    expect(refreshButton).toBeTruthy();
    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(container.textContent).not.toContain('工作区干净');
    expect(container.textContent).toContain('状态获取失败');
  });

  it('never shows the previous worktree status after switching targets', async () => {
    await render();
    expect(container.textContent).toContain('分支 feat/f322-v2-code-tools');

    let resolveWt2!: (r: Response) => void;
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('git-status') && url.includes('wt-2')) {
        return new Promise<Response>((res) => {
          resolveWt2 = res;
        });
      }
      if (url.includes('git-status')) return Response.json(STATUS);
      if (url.includes('git-log')) return Response.json(LOG);
      if (url.includes('git-health')) return Response.json(HEALTH);
      return new Response('not found', { status: 404 });
    });
    await act(async () => {
      useChatStore.setState({ workspaceWorktreeId: 'wt-2' });
      for (let i = 0; i < 6; i++) await Promise.resolve();
    });
    expect(container.textContent).not.toContain('分支 feat/f322-v2-code-tools');
    expect(container.textContent).not.toContain('packages/web/a.ts');

    await act(async () => {
      resolveWt2(Response.json({ branch: 'feat/other', staged: [], unstaged: [], untracked: [] }));
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
    expect(container.textContent).toContain('分支 feat/other');
    expect(container.textContent).toContain('工作区干净');
  });

  it('never renders Invalid Date for unparseable upstream dates', async () => {
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.includes('git-health')) {
        return Response.json({
          staleBranches: [{ name: 'feat/broken', lastCommitDate: '', author: '布偶猫', mergedInto: 'main' }],
          worktrees: [],
          runtimeDrift: {
            available: false,
            aheadOfMain: 0,
            behindMain: 0,
            runtimeHead: '',
            mainHead: '',
            behindCommits: [],
          },
        });
      }
      if (url.includes('git-log')) return Response.json(LOG);
      if (url.includes('git-status')) return Response.json(STATUS);
      return new Response('not found', { status: 404 });
    });
    await render();
    expect(container.textContent).toContain('feat/broken');
    expect(container.textContent).not.toContain('Invalid Date');
  });

  it('keeps the classic presentation untouched', async () => {
    writeShellPresentation('classic');
    await render();
    expect(container.textContent).toContain('Refresh');
    expect(container.textContent).toContain('Commits');
  });
});
