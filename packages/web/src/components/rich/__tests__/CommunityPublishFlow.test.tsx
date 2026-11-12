import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { CommunityPublishFlow } from '../CommunityPublishFlow';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const endpoint = '/api/plugins/official.github-operations/github/community-issue-drafts';
const draft = {
  draftId: 'draft-1',
  targetRepo: 'org/repo',
  title: 'Visible title',
  bodyMarkdown: 'Safe body',
  labels: [],
  status: 'draft',
};
let container: HTMLDivElement;
let root: Root;
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/report-preview'))
      return response({ title: draft.title, bodyMarkdown: draft.bodyMarkdown });
    if (String(url).endsWith('/config')) return response({ defaultRepo: 'org/repo', repos: ['org/repo'] });
    if (String(url).endsWith('/publish'))
      return response({
        draft: {
          ...draft,
          status: 'published',
          githubIssueNumber: 12,
          githubIssueUrl: 'https://github.com/org/repo/issues/12',
        },
      });
    if (init?.method === 'POST') return response({ data: { id: draft.draftId }, draft });
    return response({ draft });
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function renderFlow() {
  await act(async () =>
    root.render(
      <CommunityPublishFlow
        issueId="fi_1"
        title={draft.title}
        bodyMarkdown="Raw body"
        status="confirmed"
        onStatusChange={vi.fn()}
      />,
    ),
  );
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === text);
  expect(button, text).toBeDefined();
  await act(async () => button?.click());
}
test('confirmed local feedback prepares a sanitized preview and publishes only after separate confirmation', async () => {
  await renderFlow();
  expect(apiFetch).not.toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: 'POST' }));
  await click('预览并提交');
  expect(apiFetch).toHaveBeenCalledWith(
    endpoint,
    expect.objectContaining({
      body: JSON.stringify({
        requestId: 'feedback:fi_1',
        repo: 'org/repo',
        title: draft.title,
        bodyMarkdown: draft.bodyMarkdown,
      }),
    }),
  );
  expect(apiFetch).toHaveBeenCalledWith(`${endpoint}/by-id/draft-1`);
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).endsWith('/publish'))).toBe(false);
  await click('Submit to GitHub');
  expect(container.querySelector('a')?.href).toBe('https://github.com/org/repo/issues/12');
});
test.each([
  503, 200,
])('unavailable provider or empty target (%s) offers a report without creating a draft', async (status) => {
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/report-preview')
      ? response({ title: draft.title, bodyMarkdown: 'Safe body' })
      : response({ defaultRepo: '', repos: [] }, status),
  );
  await renderFlow();
  expect(container.textContent).toContain('尚未提交');
  expect(container.textContent).toContain('复制报告');
  expect(container.textContent).not.toContain('预览并提交');
  expect(container.querySelector('textarea')?.value).toBe('Safe body');
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.every(([, init]) => !init || init.method !== 'POST' || String(init.body).includes('Raw body')),
  ).toBe(true);
});

test('a different target returned for an existing draft is shown as a conflict, never published', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url, init) =>
    String(url).endsWith('/report-preview')
      ? response({ title: draft.title, bodyMarkdown: draft.bodyMarkdown })
      : String(url).endsWith('/config')
        ? response({ defaultRepo: 'org/repo', repos: ['org/repo'] })
        : init?.method === 'POST'
          ? response({ draft: { ...draft, targetRepo: 'previous/repo' } })
          : response({ draft }),
  );
  await renderFlow();
  await click('预览并提交');
  expect(container.textContent).toContain('已有草稿属于 previous/repo');
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/by-id/'))).toBe(false);
});
