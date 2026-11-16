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
async function renderFlow(proposedRepo?: string) {
  await act(async () =>
    root.render(
      <CommunityPublishFlow
        issueId="fi_1"
        title={draft.title}
        bodyMarkdown="Raw body"
        proposedRepo={proposedRepo}
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
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.textContent).toContain(draft.bodyMarkdown);
  expect(container.querySelector('a')?.href).toBe('https://github.com/org/repo/issues/new');
  await click('核对并继续');
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
  expect(container.querySelector('textarea')?.readOnly).toBe(false);
  expect(container.querySelector('textarea')?.disabled).toBe(false);
  await click('发布到 GitHub');
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
  await renderFlow('suggested/repo');
  expect(container.textContent).toContain('公开反馈报告');
  expect(container.querySelector('a')).toBeNull();
  expect(container.textContent).toContain('复制报告');
  expect(container.textContent).not.toContain('核对并继续');
  expect(container.textContent).toContain('Safe body');
  expect(
    vi
      .mocked(apiFetch)
      .mock.calls.every(([, init]) => !init || init.method !== 'POST' || String(init.body).includes('Raw body')),
  ).toBe(true);
});

test('a proposed target outside the configured list never becomes a manual submission link', async () => {
  await renderFlow('suggested/repo');
  expect(container.querySelector('a')).toBeNull();
  expect(container.textContent).not.toContain('核对并继续');
});

test('the native requestId content conflict offers an actionable message without publishing', async () => {
  vi.mocked(apiFetch).mockImplementation(async (url, init) =>
    String(url).endsWith('/report-preview')
      ? response({ title: draft.title, bodyMarkdown: draft.bodyMarkdown })
      : String(url).endsWith('/config')
        ? response({ defaultRepo: 'org/repo', repos: ['org/repo'] })
        : init?.method === 'POST'
          ? response({ error: 'draft requestId already has different content' }, 409)
          : response({ draft }),
  );
  await renderFlow();
  await click('核对并继续');
  expect(container.textContent).toContain('请恢复创建时的仓库与报告内容');
  expect(container.textContent).not.toContain('draft requestId already has different content');
  expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/by-id/'))).toBe(false);
});

test('remounting after publication does not claim the issue is unsubmitted and restores the same draft', async () => {
  await renderFlow();
  await click('核对并继续');
  await click('发布到 GitHub');
  const publishedDraft = {
    ...draft,
    status: 'published',
    githubIssueNumber: 12,
    githubIssueUrl: 'https://github.com/org/repo/issues/12',
  };
  vi.mocked(apiFetch).mockImplementation(async (url) =>
    String(url).endsWith('/report-preview')
      ? response({ title: draft.title, bodyMarkdown: draft.bodyMarkdown })
      : String(url).endsWith('/config')
        ? response({ defaultRepo: 'org/repo', repos: ['org/repo'] })
        : response({ draft: publishedDraft }),
  );
  await act(async () => root.render(null));
  await renderFlow();
  expect(container.textContent).not.toContain('尚未提交');
  expect(container.textContent).toContain('公开反馈报告');
  await click('核对并继续');
  expect(container.querySelector('a')?.href).toBe(publishedDraft.githubIssueUrl);
});

test('changing the proposed repository A to allowed B previews and publishes B without a false target conflict', async () => {
  const selectedDraft = { ...draft, targetRepo: 'org/B' };
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/config')) return response({ defaultRepo: 'org/A', repos: ['org/A', 'org/B'] });
    if (String(url).endsWith('/report-preview'))
      return response({ title: draft.title, bodyMarkdown: draft.bodyMarkdown });
    if (String(url).endsWith('/publish'))
      return response({
        draft: {
          ...selectedDraft,
          status: 'published',
          githubIssueNumber: 9,
          githubIssueUrl: 'https://github.com/org/B/issues/9',
        },
      });
    if (init?.method === 'POST') return response({ draft: selectedDraft });
    return response({ draft: selectedDraft });
  });
  await act(async () =>
    root.render(
      <CommunityPublishFlow
        issueId="fi_choice"
        title={draft.title}
        bodyMarkdown={draft.bodyMarkdown}
        proposedRepo="org/A"
        status="confirmed"
        onStatusChange={vi.fn()}
      />,
    ),
  );
  const select = container.querySelector('select');
  expect(select).not.toBeNull();
  await act(async () => {
    if (select) {
      select.value = 'org/B';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await click('核对并继续');
  expect(container.textContent).not.toContain('确认使用草稿原仓库');
  expect(
    [...container.querySelectorAll('button')].find((button) => button.textContent === '发布到 GitHub')?.disabled,
  ).toBe(false);
  await click('发布到 GitHub');
  expect(container.querySelector('a')?.href).toBe('https://github.com/org/B/issues/9');
});
