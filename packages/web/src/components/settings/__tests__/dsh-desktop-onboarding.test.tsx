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

it('uses Desktop automatically and applies the complete route and HOME only after a real test succeeds', async () => {
  const prepared = vi.fn(() => 'new-key');
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init: RequestInit) => {
      const action = path.split('/').at(-1)!;
      calls.push({ action, body: JSON.parse(String(init.body)) });
      const data =
        action === 'inspect'
          ? {
              desktop: true,
              revision: 'a'.repeat(64),
              provider: 'custom',
              model: 'custom-model',
              providers: [
                { id: 'deepseek-official', credential: 'missing', models: [{ id: 'official', label: 'Official' }] },
                { id: 'custom', credential: 'configured', models: [{ id: 'custom-model', label: 'Custom' }] },
              ],
            }
          : action === 'prepare'
            ? {
                id: 'receipt',
                command: 'dsh.cmd',
                startupArgs: ['--profile', 'acp', '--patch', '/host/member.yml'],
                env: { DSH_HOME: '/host/home' },
                provider: 'custom',
                model: 'custom-model',
              }
            : { ok: true };
      if (action === 'test') expect(prepared).not.toHaveBeenCalled();
      return new Response(JSON.stringify(data));
    }),
  );
  await act(async () => root.render(<DshProviderSetup runtimeId="dsh" onPrepared={prepared} t={(zh) => zh} />));
  const read = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('读取'))!;
  if (!calls.length) await act(async () => read.click());
  expect(calls[0]).toEqual({ action: 'inspect', body: { runtimeId: 'dsh' } });
  expect(host.textContent).not.toContain('读取配置来源');
  await act(async () =>
    [...host.querySelectorAll('button')].find((b) => b.textContent === '验证并使用此模型')!.click(),
  );
  expect(calls.map((c) => c.action)).toEqual(['inspect', 'prepare', 'test']);
  expect(calls[2]?.body).toMatchObject({ model: '["custom","custom-model"]' });
  expect(prepared).toHaveBeenCalledWith(
    expect.objectContaining({ env: { DSH_HOME: '/host/home' }, provider: 'custom' }),
  );
});
