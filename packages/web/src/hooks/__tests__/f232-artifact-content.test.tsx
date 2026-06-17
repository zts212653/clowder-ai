/**
 * F232 AC-A7 — useArtifactContent：文本类产物在 panel 内看正文的内容获取 hook。
 * 三条路径：uploads url 直接 fetch / repo 文件走 workspace API / 无源（含 repo 文件但无 worktreeId）→ error 降级。
 */
import type { ThreadArtifactDTO } from '@cat-cafe/shared';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useArtifactContent } from '@/hooks/useArtifactContent';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({ API_URL: 'http://test.local', apiFetch: vi.fn() }));

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

type S = ReturnType<typeof useArtifactContent>;
function Probe({
  artifact,
  worktreeId,
  onState,
}: {
  artifact: ThreadArtifactDTO | null;
  worktreeId: string | null;
  onState: (s: S) => void;
}) {
  const state = useArtifactContent(artifact, worktreeId, true);
  useEffect(() => {
    onState(state);
  });
  return null;
}

describe('F232 AC-A7 useArtifactContent', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uploads url 文本（站内）→ apiFetch 带 session cookie（hosted 跨域必须带 credentials，云端 P1）', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, text: async () => '# Hello' } as Response);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const states: S[] = [];
    await act(async () => {
      root.render(
        createElement(Probe, {
          artifact: {
            type: 'file',
            name: 'x.md',
            url: '/uploads/x.md',
            createdAt: 1,
            catId: null,
            sourceMessageId: null,
          },
          worktreeId: null,
          onState: (s) => states.push(s),
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const last = states[states.length - 1];
    expect(last.content).toBe('# Hello');
    expect(last.isMarkdown).toBe(true);
    // 站内 uploads 走 apiFetch（credentials:'include'），不走裸 fetch——
    // 否则 hosted 路径 cafe→api.clowder-ai.com 跨域无 cookie → Access/会话 401 → error fallback
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/uploads/x.md');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('外链 url 产物 → 裸 fetch 不发 cookie（防 cookie 泄露第三方）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => 'external body' });
    vi.stubGlobal('fetch', fetchMock);
    const states: S[] = [];
    await act(async () => {
      root.render(
        createElement(Probe, {
          artifact: {
            type: 'file',
            name: 'r.md',
            url: 'https://raw.example.com/r.md',
            createdAt: 1,
            catId: null,
            sourceMessageId: null,
          },
          worktreeId: null,
          onState: (s) => states.push(s),
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const last = states[states.length - 1];
    expect(last.content).toBe('external body');
    // 外链原样裸 fetch，不带 credentials（apiFetch 会拼 API_URL 前缀破坏外链 + 发 cookie 给第三方）
    expect(fetchMock).toHaveBeenCalledWith('https://raw.example.com/r.md');
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('repo 文件（ref + worktreeId）→ workspace API 返回正文', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({ content: 'backlog body', mime: 'text/markdown' }),
    } as Response);
    const states: S[] = [];
    await act(async () => {
      root.render(
        createElement(Probe, {
          artifact: {
            type: 'file',
            name: 'BACKLOG.md',
            ref: 'docs/ROADMAP.md',
            createdAt: 1,
            catId: null,
            sourceMessageId: null,
          },
          worktreeId: 'wt1',
          onState: (s) => states.push(s),
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const last = states[states.length - 1];
    expect(last.content).toBe('backlog body');
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
      expect.stringContaining('/api/workspace/file?worktreeId=wt1&path=docs%2FBACKLOG.md'),
    );
  });

  it('repo 文件无 worktreeId → error 降级（不 fetch）', async () => {
    const states: S[] = [];
    await act(async () => {
      root.render(
        createElement(Probe, {
          artifact: {
            type: 'file',
            name: 'BACKLOG.md',
            ref: 'docs/ROADMAP.md',
            createdAt: 1,
            catId: null,
            sourceMessageId: null,
          },
          worktreeId: null,
          onState: (s) => states.push(s),
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const last = states[states.length - 1];
    expect(last.error).toBe(true);
    expect(last.content).toBeNull();
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });

  it('workspace API 404 → error 降级', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
    const states: S[] = [];
    await act(async () => {
      root.render(
        createElement(Probe, {
          artifact: {
            type: 'code',
            name: 'a.ts',
            ref: 'src/missing.ts',
            createdAt: 1,
            catId: null,
            sourceMessageId: null,
          },
          worktreeId: 'wt1',
          onState: (s) => states.push(s),
        }),
      );
    });
    await act(async () => {
      await flush();
    });
    const last = states[states.length - 1];
    expect(last.error).toBe(true);
  });
});
