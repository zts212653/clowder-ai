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
const inspection = {
  revision: 'a'.repeat(64),
  provider: 'custom',
  model: 'custom-model',
  providers: [{ id: 'custom', credential: 'configured', models: [{ id: 'custom-model', label: 'Custom' }] }],
};
const connection = {
  id: 'receipt',
  command: 'dsh.cmd',
  startupArgs: ['--profile', 'acp', '--patch', '/host/member.yml'],
  env: { DSH_HOME: '/host/home' },
  provider: 'custom',
  model: 'custom-model',
};
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label)!;
  await act(async () => button.click());
}

it.each([
  ['dsh_setup_changed', '配置已变化'],
  ['dsh_setup_credential_missing', '未配置认证'],
  ['dsh_setup_auth_refresh_required', '更新登录认证'],
])('preserves the member draft when verification fails with %s', async (error, message) => {
  const prepared = vi.fn();
  const fetch = vi.fn(
    async (path: string) =>
      new Response(
        JSON.stringify(path.endsWith('inspect') ? inspection : path.endsWith('prepare') ? connection : { error }),
        { status: path.endsWith('test') ? 422 : 200 },
      ),
  );
  vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(<DshProviderSetup runtimeId="dsh" onPrepared={prepared} t={(zh) => zh} />));
  expect(fetch).not.toHaveBeenCalled();
  await click('读取 Desktop 配置');
  await click('验证并使用此模型');
  expect(host.textContent).toContain(message);
  expect(prepared).not.toHaveBeenCalled();
});

it.each(['prepare', 'test'])('ignores a late %s response after the launch or preferences change', async (stage) => {
  const prepared = vi.fn();
  let accept: ((response: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      path.endsWith(stage)
        ? new Promise<Response>((resolve) => {
            accept = resolve;
          })
        : Promise.resolve(new Response(JSON.stringify(path.endsWith('inspect') ? inspection : connection))),
    ),
  );
  const render = (key: string) =>
    root.render(<DshProviderSetup runtimeId="dsh" verificationKey={key} onPrepared={prepared} t={(zh) => zh} />);
  await act(async () => render('old'));
  await click('读取 Desktop 配置');
  await click('验证并使用此模型');
  await act(async () => render('changed'));
  await act(async () => accept!(new Response(JSON.stringify(stage === 'prepare' ? connection : { ok: true }))));
  expect(prepared).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('此配置已收到模型回复');
});
