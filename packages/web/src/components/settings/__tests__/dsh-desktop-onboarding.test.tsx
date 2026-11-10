import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { DshProviderSetup } from '../members/DshProviderSetup';

vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
it('shows the existing custom default when official authentication is missing without a paid request', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const fetch = vi.fn(async () =>
    Response.json({
      revision: 'r',
      provider: 'custom',
      model: 'custom-model',
      providers: [
        { id: 'deepseek-official', credential: 'missing', models: [{ id: 'official', label: 'Official' }] },
        { id: 'custom', credential: 'configured', models: [{ id: 'custom-model', label: 'Custom' }] },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetch);
  const host = document.createElement('div');
  const root = createRoot(host);
  const selection = vi.fn();
  await act(async () => root.render(<DshProviderSetup runtimeId="dsh" onSelection={selection} t={(zh) => zh} />));
  expect(host.textContent).toContain('Custom');
  expect(host.textContent).toContain('调整模型');
  expect(fetch).toHaveBeenCalledOnce();
  expect(selection).not.toHaveBeenCalled();
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
