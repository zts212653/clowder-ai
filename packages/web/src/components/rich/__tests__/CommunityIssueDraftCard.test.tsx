import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { CommunityIssueDraftCard, isCommunityIssueDraftBlock } from '../CommunityIssueDraftCard';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true });
const block = {
  id: 'proposal-1',
  kind: 'card' as const,
  v: 1 as const,
  title: 'Issue',
  meta: { kind: 'community_issue_draft', draftId: 'retained-id' },
};
test('only Agent messages route a draft card; connectors cannot impersonate publish UI', () => {
  expect(isCommunityIssueDraftBlock(block)).toBe(true);
  expect(isCommunityIssueDraftBlock(block, { connector: 'external' })).toBe(false);
  expect(isCommunityIssueDraftBlock({ ...block, meta: {} })).toBe(false);
});
test.each([
  'published',
  'cancelled',
])('retained draft ID hydrates %s without create or publish, including after remount', async (status) => {
  vi.mocked(apiFetch).mockReset();
  const url = 'https://github.com/org/repo/issues/4';
  vi.mocked(apiFetch).mockImplementation(
    async (path) =>
      new Response(
        JSON.stringify(
          String(path).includes('/by-id/')
            ? {
                draft: {
                  draftId: 'retained-id',
                  title: 'Issue',
                  bodyMarkdown: 'Details',
                  targetRepo: 'org/repo',
                  labels: [],
                  status,
                  githubIssueUrl: url,
                  githubIssueNumber: 4,
                },
              }
            : String(path).endsWith('/config')
              ? { defaultRepo: '', repos: [] }
              : { title: 'Issue', bodyMarkdown: 'Details' },
        ),
      ),
  );
  for (let mount = 0; mount < 2; mount++) {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => root.render(<CommunityIssueDraftCard block={block} messageId="original-message" />));
    expect(container.textContent).toContain(status === 'published' ? 'Published to Community' : 'Publish cancelled');
    if (status === 'published') expect(container.querySelector('a')?.href).toBe(url);
    expect(
      vi
        .mocked(apiFetch)
        .mock.calls.some(([path, init]) => !String(path).endsWith('/report-preview') && init?.method === 'POST'),
    ).toBe(false);
    await act(async () => root.unmount());
  }
});
