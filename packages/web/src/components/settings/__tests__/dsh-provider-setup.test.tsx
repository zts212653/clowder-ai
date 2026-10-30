import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DshProviderSetup } from '../members/DshProviderSetup';

const host = document.createElement('div');
const root = createRoot(host);
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(async () => {
  await act(async () => root.render(null));
  vi.unstubAllGlobals();
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
  const setupHint = [...host.querySelectorAll('p')].find((element) =>
    element.textContent?.includes('手动接入或调整 DSH 连接'),
  );
  expect(setupHint).toBeDefined();
  expect(setupHint?.closest('details')).toBeNull();
  expect(host.querySelector('details')?.open).toBe(false);
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.textContent).toContain('deepseek-official');
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === '使用此配置')!.click());
  expect(prepared).toHaveBeenCalledWith('node', ['dsh.js', '--profile', 'acp', '--patch', '/host/custom.yml']);
  expect(host.textContent).toContain('请保存成员');
  const setupCalls = fetch.mock.calls.filter(([path]) => path.includes('/dsh-setup/'));
  expect(setupCalls).toHaveLength(2);
  expect(JSON.parse(setupCalls[1]![1]!.body as string)).toMatchObject({ provider: 'custom', model: 'custom-model' });
});
it('preserves the draft and offers retry when composition changed', async () => {
  const prepared = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, json: async () => ({ error: 'dsh_setup_changed', profiles: ['desktop'] }) })),
  );
  await act(async () => root.render(<DshProviderSetup runtimeId="dsh" onPrepared={prepared} t={(zh) => zh} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.textContent).toContain('配置已变化');
  expect(prepared).not.toHaveBeenCalled();
});
it('explains unsupported automatic copies without replacing the member draft', async () => {
  const prepared = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'dsh_config_manual' }), { status: 400 })),
  );
  await act(async () => root.render(<DshProviderSetup runtimeId="dsh" onPrepared={prepared} t={(zh) => zh} />));
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.querySelector('[role=alert]')?.textContent).toContain('无法安全自动复制');
  expect(host.querySelector('[role=alert]')?.textContent).toContain('保留原配置');
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
