import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { apiFetch } from '@/utils/api-client';
import { CommunityIssuePreviewCard } from '../CommunityIssuePreviewCard';

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
