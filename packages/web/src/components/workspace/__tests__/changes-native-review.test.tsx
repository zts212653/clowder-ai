import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('../DiffViewer', () => ({ DiffViewer: () => null }));
vi.mock('../FileIcons', () => ({ FileIcon: () => null }));
vi.mock('../../ThreadSidebar/ThreadNativeReviewSettings', () => ({
  ThreadNativeReviewSettingsContent: ({ threadId }: { threadId: string }) => (
    <div data-testid="native-review-workspace">review:{threadId}</div>
  ),
}));

import { ChangesPanel } from '../ChangesPanel';

describe('ChangesPanel native Review placement', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ changedFiles: [], diff: '' }), { status: 200 }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('places the structured Review action in the existing Workspace Changes surface', async () => {
    await act(async () => root.render(<ChangesPanel worktreeId="wt-1" basisPct={40} threadId="thread-1" />));
    expect(container.querySelector('[data-testid="native-review-workspace"]')?.textContent).toBe('review:thread-1');
  });
});
