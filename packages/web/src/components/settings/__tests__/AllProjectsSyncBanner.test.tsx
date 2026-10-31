import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AllProjectsSyncBanner } from '../AllProjectsSyncBanner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('shows batch failures inside the open dialog and retains errors after reports become clean', async () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const issue = { id: 'missing', issueType: 'global-new', message: 'Pending' };
  const scope = { key: '/project', label: 'project', path: '/project', issues: [issue] };
  const error = '/projects/broken: permission denied';
  const props = {
    type: 'mcp' as const,
    scopes: [scope],
    scopesWithIssues: [scope],
    syncing: false,
    onSyncAll: vi.fn(),
  };
  try {
    await act(async () => root.render(<AllProjectsSyncBanner {...props} error={null} />));
    await act(async () => container.querySelector('button')?.click());
    await act(async () => root.render(<AllProjectsSyncBanner {...props} error={error} />));
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(error);
    await act(async () => root.render(<AllProjectsSyncBanner {...props} scopesWithIssues={[]} error={error} />));
    expect(container.textContent).toContain(error);
    expect(container.textContent).not.toContain('同步一致');
  } finally {
    await act(async () => root.unmount());
  }
});
