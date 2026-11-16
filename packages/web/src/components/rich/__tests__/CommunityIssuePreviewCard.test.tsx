import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { CommunityIssuePreviewCard, isCommunityIssuePreviewBlock } from '../CommunityIssuePreviewCard';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
let root: Root;
let container: HTMLDivElement;
const draft = {
  draftId: 'draft/a#1',
  status: 'draft',
  title: 'Issue',
  bodyMarkdown: 'Details',
  targetRepo: 'owner/repo',
  labels: [],
};
const endpoint = '/api/plugins/official.github-operations/github/community-issue-drafts/by-id/draft%2Fa%231';
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ draft }) } as Response);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
for (const action of ['publish', 'cancel'] as const) {
  it(`hydrates and sends ${action} through the plugin by-id path with a single encoded identifier`, async () => {
    await act(async () => {
      root.render(<CommunityIssuePreviewCard inlineDraftId={draft.draftId} />);
    });
    expect(apiFetch).toHaveBeenCalledWith(endpoint);
    const button = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === (action === 'publish' ? '发布到 GitHub' : '取消草稿'),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
    expect(apiFetch).toHaveBeenLastCalledWith(`${endpoint}/${action}`, expect.objectContaining({ method: 'POST' }));
  });
}

it('never marks a successful HTTP response without a real Issue receipt as published; retries the same draft', async () => {
  let publishes = 0;
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      publishes++;
      return {
        ok: true,
        json: async () => ({
          draft:
            publishes === 1
              ? draft
              : {
                  ...draft,
                  status: 'published',
                  githubIssueNumber: 7,
                  githubIssueUrl: 'https://github.com/owner/repo/issues/7',
                },
        }),
      } as Response;
    }
    return { ok: true, json: async () => ({ draft }) } as Response;
  });
  await act(async () => root.render(<CommunityIssuePreviewCard inlineDraftId={draft.draftId} />));
  await act(async () => container.querySelector('button')?.click());
  expect(container.textContent).not.toContain('已发布到 GitHub');
  expect(container.textContent).toContain('尚未确认');
  await act(async () => container.querySelector('button')?.click());
  expect(container.querySelector('a')?.href).toBe('https://github.com/owner/repo/issues/7');
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([, init]) => init?.method === 'POST')
      .map(([url]) => url),
  ).toEqual([`${endpoint}/publish`, `${endpoint}/publish`]);
});
it('hydrate failure exposes reload, never an enabled publish action', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 503 } as Response);
  await act(async () => root.render(<CommunityIssuePreviewCard inlineDraftId={draft.draftId} />));
  expect([...container.querySelectorAll('button')].some((button) => button.textContent === '发布到 GitHub')).toBe(
    false,
  );
  expect(container.textContent).toContain('重新加载草稿');
});

it('a retained draft for a different proposed repository requires explicit target confirmation', async () => {
  await act(async () =>
    root.render(<CommunityIssuePreviewCard inlineDraftId={draft.draftId} expectedRepo="other/repo" />),
  );
  const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === '发布到 GitHub');
  expect(submit?.disabled).toBe(true);
  const confirm = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '确认使用草稿原仓库',
  );
  await act(async () => confirm?.click());
  expect(submit?.disabled).toBe(false);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('retains a real uncertain 409 draft, locks edits and retries the same draft in Chinese', async () => {
  let publishes = 0;
  vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
    if (init?.method !== 'POST') return new Response(JSON.stringify({ draft }));
    publishes++;
    return new Response(
      JSON.stringify(
        publishes === 1
          ? {
              error: 'Publication outcome uncertain. Retry to look for the original issue without creating another.',
              draft: { ...draft, status: 'publishing' },
            }
          : {
              draft: {
                ...draft,
                status: 'published',
                githubIssueNumber: 7,
                githubIssueUrl: 'https://github.com/owner/repo/issues/7',
              },
            },
      ),
      { status: publishes === 1 ? 409 : 200 },
    );
  });
  await act(async () => root.render(<CommunityIssuePreviewCard inlineDraftId={draft.draftId} />));
  await act(async () => container.querySelector('button')?.click());
  expect(container.textContent).toContain('暂未确认 GitHub 是否已创建');
  expect(container.textContent).not.toContain('Publication outcome uncertain');
  expect(container.querySelector('textarea')?.disabled).toBe(true);
  expect(container.querySelector('button')?.textContent).toBe('重新核对结果');
  await act(async () => container.querySelector('button')?.click());
  expect(container.querySelector('a')?.href).toBe('https://github.com/owner/repo/issues/7');
  expect(container.querySelector('details')?.textContent).toContain('Details');
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.filter(([, init]) => init?.method === 'POST')
      .map(([url]) => url),
  ).toEqual([`${endpoint}/publish`, `${endpoint}/publish`]);
});

it('keeps the trusted connector block entry and its irreversible cancellation callback', async () => {
  const block = {
    id: 'connector-preview',
    kind: 'card' as const,
    v: 1 as const,
    title: 'Preview',
    meta: { kind: 'community_issue_preview', draftId: draft.draftId },
    fields: [
      { label: 'Repository', value: 'owner/repo' },
      { label: 'Labels', value: 'bug' },
    ],
  };
  expect(isCommunityIssuePreviewBlock(block, { connector: 'community-publisher' })).toBe(true);
  expect(isCommunityIssuePreviewBlock(block, { connector: 'external' })).toBe(false);
  const cancelled = vi.fn();
  vi.mocked(apiFetch).mockImplementation(
    async (_url, init) =>
      new Response(JSON.stringify({ draft: { ...draft, status: init?.method === 'POST' ? 'cancelled' : 'draft' } })),
  );
  await act(async () => root.render(<CommunityIssuePreviewCard block={block} onDraftCancelled={cancelled} />));
  expect(apiFetch).toHaveBeenCalledWith(endpoint);
  expect(container.textContent).toContain('owner/repo');
  const cancel = [...container.querySelectorAll('button')].find((button) => button.textContent === '取消草稿');
  await act(async () => cancel?.click());
  expect(apiFetch).toHaveBeenLastCalledWith(`${endpoint}/cancel`, { method: 'POST' });
  expect(cancelled).toHaveBeenCalledOnce();
  expect(container.textContent).toContain('已取消草稿');
  expect(container.textContent).not.toContain('重新打开');
  expect(container.querySelector('textarea')).toBeNull();
});
