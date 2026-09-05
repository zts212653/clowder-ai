import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HubAccountsTab } from '../HubAccountsTab';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(async () =>
    Response.json({
      projectPath: '/fixture',
      providers: [
        {
          id: 'good',
          name: 'Good account',
          displayName: 'Good account',
          authType: 'api_key',
          kind: 'api_key',
          builtin: false,
          mode: 'api_key',
          models: [],
          hasApiKey: true,
        },
      ],
      unavailableAccounts: [
        {
          accountRef: 'claude',
          state: 'rejected',
          reason: 'account "claude" is divergent between workspace/runtime stores; reconcile before use',
        },
      ],
    }),
  ),
}));
vi.mock('@/components/useConfirm', () => ({ useConfirm: () => vi.fn() }));
it('shows healthy accounts alongside unavailable account diagnostics', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<HubAccountsTab />));
    expect(container.textContent).toContain('Good account');
    expect(container.textContent).toContain('claude');
    expect(container.textContent).toContain('divergent');
    expect(container.querySelector('[aria-label="Unavailable Accounts"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="Unavailable Accounts"]')?.querySelector('button')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
