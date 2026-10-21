import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { CommunityPublishFlow } from '../CommunityPublishFlow';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
test('confirmed feedback sends explicit content and displays the plugin result without Host draft links', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    calls.push({ url: String(url), init });
    return {
      ok: true,
      json: async () =>
        String(url).endsWith('/config')
          ? { defaultRepo: 'org/repo', repos: ['org/repo'] }
          : {
              data: {
                id: 'draft-1',
                repo: 'org/repo',
                title: 'Visible title',
                bodyMarkdown: 'Visible body',
                status: 'draft',
              },
            },
    } as Response;
  });
  const container = document.createElement('div');
  const root = createRoot(container);
  const onStatusChange = vi.fn();
  try {
    await act(async () =>
      root.render(
        <CommunityPublishFlow
          issueId="fi_1"
          title="Visible title"
          bodyMarkdown="Visible body"
          status="confirmed"
          onStatusChange={onStatusChange}
        />,
      ),
    );
    await act(async () => container.querySelector('button')!.click());
    const write = calls.find((call) => call.init?.method === 'POST')!;
    expect(write.url).toBe('/api/plugins/official.github-operations/github/community-issue-drafts');
    expect(JSON.parse(write.init!.body as string)).toEqual({
      requestId: 'feedback:fi_1',
      repo: 'org/repo',
      title: 'Visible title',
      bodyMarkdown: 'Visible body',
    });
    await act(async () =>
      root.render(
        <CommunityPublishFlow
          issueId="fi_1"
          title="Visible title"
          bodyMarkdown="Visible body"
          status="draft_created"
          onStatusChange={onStatusChange}
        />,
      ),
    );
    expect(container.textContent).toContain('Visible title');
    expect(container.textContent).toContain('draft-1');
    expect(calls.some((call) => /frustration-issue|by-id/.test(call.url))).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
