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

it('checks the registered DSH launch without requiring configuration copying and does not verify a failed request', async () => {
  const verified = vi.fn();
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(new Response(JSON.stringify({ error: 'dsh_setup_credential_missing' }), { status: 422 }));
  vi.stubGlobal('fetch', fetch);
  await act(async () =>
    root.render(<DshProviderSetup runtimeId="acp:dsh" onPrepared={vi.fn()} onVerified={verified} t={(zh) => zh} />),
  );
  expect(fetch).not.toHaveBeenCalled();
  const button = [...host.querySelectorAll('button')].find((item) => item.textContent === '验证当前配置');
  expect(button).toBeDefined();
  await act(async () => button!.click());
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/cats/dsh-setup/verify');
  expect(verified).not.toHaveBeenCalled();
  expect(host.textContent).toContain('凭据引用');
  fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true })));
  await act(async () => button!.click());
  expect(verified).toHaveBeenCalledOnce();
});

it('reads only on request and prepares a complete route for the existing member save flow', async () => {
  const prepared = vi.fn();
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes('/dsh-setup/')) expect(init?.method).toBe('POST');
    return {
      ok: true,
      json: async () =>
        path.endsWith('inspect')
          ? {
              profiles: ['acp', 'desktop'],
              sourceProfile: 'acp',
              revision: 'a'.repeat(64),
              active: { provider: 'deepseek-official', model: 'official', providers: [] },
              source: { providers: [{ id: 'custom', models: [{ id: 'custom-model', label: 'Custom model' }] }] },
            }
          : {
              id: 'receipt',
              command: 'node',
              startupArgs: ['dsh.js', '--profile', 'acp', '--patch', '/host/custom.yml'],
            },
    };
  });
  vi.stubGlobal('fetch', fetch);
  await act(async () => root.render(<DshProviderSetup runtimeId="dsh" onPrepared={prepared} t={(zh) => zh} />));
  expect(fetch).not.toHaveBeenCalled();
  const firstUseHint = [...host.querySelectorAll('p')].find((element) =>
    element.textContent?.includes('首次使用自定义接口'),
  );
  expect(firstUseHint).toBeDefined();
  expect(firstUseHint?.closest('details')).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.textContent).toContain('deepseek-official');
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '使用此配置')!.click());
  expect(prepared).toHaveBeenCalledWith('node', ['dsh.js', '--profile', 'acp', '--patch', '/host/custom.yml']);
  expect(host.textContent).toContain('请保存成员');
  const setupCalls = fetch.mock.calls.filter(([path]) => path.includes('/dsh-setup/'));
  expect(setupCalls).toHaveLength(2);
  expect(JSON.parse(setupCalls[1]![1]!.body as string)).toMatchObject({ provider: 'custom', model: 'custom-model' });
});
it.each([
  ['dsh_setup_changed', '配置已变化'],
  ['dsh_config_manual', '无法安全自动复制'],
])('preserves the draft and explains %s', async (error, message) => {
  const prepared = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, json: async () => ({ error, profiles: ['desktop'] }) })),
  );
  await act(async () => root.render(<DshProviderSetup runtimeId="dsh" onPrepared={prepared} t={(zh) => zh} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.textContent).toContain(message);
  expect(prepared).not.toHaveBeenCalled();
});
it.each(['runtime', 'launch'])('does not apply a late preparation result after changing %s', async (change) => {
  const prepared = vi.fn();
  let resolvePreparation: ((value: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      if (path.endsWith('prepare'))
        return new Promise<Response>((done) => {
          resolvePreparation = done;
        });
      return new Response(
        JSON.stringify({
          profiles: ['acp'],
          revision: 'a'.repeat(64),
          active: { providers: [] },
          source: { providers: [{ id: 'custom', models: [{ id: 'model', label: 'Model' }] }] },
        }),
      );
    }),
  );
  await act(async () => root.render(<DshProviderSetup runtimeId="dsh" onPrepared={prepared} t={(zh) => zh} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button')?.click());
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '使用此配置')?.click());
  await act(async () =>
    root.render(
      <DshProviderSetup
        runtimeId={change === 'runtime' ? 'acp:another' : 'dsh'}
        configurationKey={change === 'launch' ? 'edited-launch' : undefined}
        onPrepared={prepared}
        t={(zh) => zh}
      />,
    ),
  );
  await act(async () =>
    resolvePreparation?.(new Response(JSON.stringify({ id: 'old', command: 'old-dsh', startupArgs: [] }))),
  );
  expect(prepared).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('请保存成员');
});

it('ignores a successful response after the selected model changes', async () => {
  const verified = vi.fn();
  let finish: ((value: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  await act(async () =>
    root.render(
      <DshProviderSetup
        runtimeId="dsh"
        verificationKey="model-a"
        onPrepared={vi.fn()}
        onVerified={verified}
        t={(zh) => zh}
      />,
    ),
  );
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '验证当前配置')!.click());
  await act(async () =>
    root.render(
      <DshProviderSetup
        runtimeId="dsh"
        verificationKey="model-b"
        onPrepared={vi.fn()}
        onVerified={verified}
        t={(zh) => zh}
      />,
    ),
  );
  await act(async () => finish?.(new Response(JSON.stringify({ ok: true }))));
  expect(verified).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('当前配置已收到模型文本回复');
});
