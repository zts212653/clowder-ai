import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { CommunityIssuePreviewCard } from '../CommunityIssuePreviewCard';

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
      (button) => button.textContent === (action === 'publish' ? 'Submit to GitHub' : 'Cancel'),
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
  expect(container.textContent).not.toContain('Published to Community');
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
  expect([...container.querySelectorAll('button')].some((button) => button.textContent === 'Submit to GitHub')).toBe(
    false,
  );
  expect(container.textContent).toContain('重新加载草稿');
});

it('a retained draft for a different proposed repository requires explicit target confirmation', async () => {
  await act(async () =>
    root.render(<CommunityIssuePreviewCard inlineDraftId={draft.draftId} expectedRepo="other/repo" />),
  );
  const submit = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Submit to GitHub');
  expect(submit?.disabled).toBe(true);
  const confirm = [...container.querySelectorAll('button')].find(
    (button) => button.textContent === '确认使用草稿原仓库',
  );
  await act(async () => confirm?.click());
  expect(submit?.disabled).toBe(false);
  expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
