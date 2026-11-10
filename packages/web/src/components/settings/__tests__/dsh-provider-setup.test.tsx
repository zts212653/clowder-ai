import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DshProviderSetup } from '../members/DshProviderSetup';

vi.mock('@/utils/api-client', () => ({ apiFetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const host = document.createElement('div');
const root = createRoot(host);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root.render(null));
  vi.unstubAllGlobals();
});
it('automatically reads metadata, keeps explicit preferences and never prepares or tests on opening', async () => {
  const select = vi.fn();
  const fetch = vi.fn(async (path: string) => {
    expect(path).toContain('/inspect');
    return Response.json({
      revision: 'r',
      provider: 'official',
      model: 'default',
      providers: [
        { id: 'official', credential: 'configured', models: [{ id: 'default', label: 'Default' }] },
        { id: 'custom', credential: 'configured', models: [{ id: 'chosen', label: 'Chosen' }] },
      ],
    });
  });
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(
      <DshProviderSetup runtimeId="dsh" selectedModel='["custom","chosen"]' onSelection={select} t={(zh) => zh} />,
    ),
  );
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0][0]).toContain('/inspect');
  expect(host.textContent).toContain('Chosen');
  expect(select).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('验证并使用');
  expect(host.textContent).not.toContain('客户端未上报');
});
it('ignores an old installation response after changing sources', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url, init: RequestInit) =>
      JSON.parse(String(init.body)).runtimeId === 'old'
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(Response.json({ providers: [], revision: 'new' })),
    ),
  );
  await act(async () => root.render(<DshProviderSetup runtimeId="old" onSelection={vi.fn()} t={(zh) => zh} />));
  await act(async () => root.render(<DshProviderSetup runtimeId="new" onSelection={vi.fn()} t={(zh) => zh} />));
  await act(async () =>
    finish(
      Response.json({
        provider: 'old',
        model: 'old',
        providers: [{ id: 'old', credential: 'configured', models: [{ id: 'old', label: 'Old result' }] }],
      }),
    ),
  );
  expect(host.textContent).not.toContain('Old result');
});
